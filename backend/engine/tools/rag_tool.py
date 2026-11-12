"""
Policy section retrieval for compliance evaluation.
Uses pgvector cosine-similarity search on the 1536-dim embedding column.
Falls back to keyword/ILIKE text search if embeddings are unavailable.
"""
import logging
import re
from typing import List, Optional
from uuid import UUID

from sqlalchemy import bindparam
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, select, text, or_

from core.models import PolicySection
from engine.llm import get_embeddings


def search_policy_sections(
    policy_id: str,
    session: Session,
    keywords: Optional[List[str]] = None,
    limit: int = 8,
) -> str:
    """
    Retrieve policy section text relevant to the given keywords.

    Embeds the query string and performs a pgvector cosine-similarity search
    against policy_sections.embedding.  Falls back to in-Python keyword
    filtering if embedding fails.

    Returns a single concatenated string ready to inject into a prompt.
    """
    policy_uuid = UUID(policy_id)
    query_text = " ".join(keywords) if keywords else ""

    # --- Vector similarity path ---
    if query_text:
        try:
            embedder = get_embeddings()
            query_vector = embedder.embed_query(query_text)

            # pgvector cosine distance operator: <=>
            # Lower distance == more similar.  We ORDER ASC and take `limit` rows.
            sql = text("""
                SELECT section_id, content
                FROM policy_sections
                WHERE policy_id = :policy_id AND embedding IS NOT NULL
                ORDER BY embedding <=> CAST(:qvec AS vector)
                LIMIT :lim
            """)
            rows = session.execute(
                sql,
                {
                    "policy_id": str(policy_uuid),
                    "qvec": str(query_vector),
                    "lim": limit,
                },
            ).fetchall()

            if rows:
                parts = [
                    f"[Section {i}]\n{row[1][:1500]}"
                    for i, row in enumerate(rows, 1)
                ]
                return "\n\n".join(parts)

        except Exception as e:
            print(f"Vector search failed, falling back to keyword search: {e}")

    # --- Keyword fallback: push filter to DB with ILIKE ---
    if keywords:
        kw_lower = [k.lower() for k in keywords if k]
        stmt = (
            select(PolicySection)
            .where(
                PolicySection.policy_id == policy_uuid,
                or_(*[PolicySection.content.ilike(f"%{kw}%") for kw in kw_lower]),
            )
            .limit(limit)
        )
    else:
        stmt = select(PolicySection).where(PolicySection.policy_id == policy_uuid).limit(limit)

    sections = session.exec(stmt).all()

    if not sections:
        return ""

    parts = []
    for i, s in enumerate(sections, 1):
        excerpt = s.content[:1500]
        parts.append(f"[Section {i}]\n{excerpt}")

    return "\n\n".join(parts)


_logger = logging.getLogger(__name__)

_VECTOR_IDS_SQL = text("""
    SELECT section_id
    FROM policy_sections
    WHERE policy_id IN :policy_ids AND embedding IS NOT NULL
    ORDER BY embedding <=> CAST(:qvec AS vector)
    LIMIT :lim
""").bindparams(bindparam("policy_ids", expanding=True))

# Words that appear in almost any question or section and would match everything.
_STOP_WORDS = frozenset("""
    a an and are can could did does for from get had has have how i if in is it its may me my of on or our
    should so than that the their them then there they this to was we what when where which who why will
    with would you your claim claims policy company allowed allow much many need want please
""".split())


def find_policy_sections(policy_ids: List[UUID], session: Session, query: str, limit: int = 6) -> List[PolicySection]:
    """Sections of the given policies most related to a free-text question, as rows.

    Vector search first (the question is embedded once); keyword search when embeddings fail or none exist.
    """
    if not policy_ids:
        return []
    ids = [str(p) for p in policy_ids]
    if query.strip():
        try:
            vector = get_embeddings().embed_query(query)
            hit_ids = [row[0] for row in session.execute(
                _VECTOR_IDS_SQL, {"policy_ids": ids, "qvec": str(vector), "lim": limit}
            ).fetchall()]
            if hit_ids:
                found = {s.section_id: s for s in session.exec(
                    select(PolicySection).where(PolicySection.section_id.in_(hit_ids))).all()}
                return [found[i] for i in hit_ids if i in found]
        except Exception as e:
            _logger.warning("[RAG] vector search failed, using keywords: %s", e)
            if isinstance(e, SQLAlchemyError):
                session.rollback()  # a failed statement aborts the Postgres transaction
    words = [w for w in dict.fromkeys(re.findall(r"[a-z]{3,}", query.lower())) if w not in _STOP_WORDS][:10]
    if not words:
        return []
    rows = session.exec(
        select(PolicySection)
        .where(PolicySection.policy_id.in_(policy_ids),
               or_(*[PolicySection.content.ilike(f"%{w}%") for w in words]))
        .limit(200)
    ).all()

    def rank(s: PolicySection) -> tuple[int, int]:
        return -sum(w in (s.content or "").lower() for w in words), s.section_order or 0

    return sorted(rows, key=rank)[:limit]
