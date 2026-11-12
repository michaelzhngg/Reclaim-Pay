from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from api import deps
from core.enums import PolicyStatus, UserRole
from core.models import Policy, PolicyQuestion, PolicyReimbursableCategory, PolicySection, User
from engine.policy.limits import LimitRule, LimitUnit
from engine.services import policy_limits_store as store
from engine.services import policy_qa as qa

NOW = datetime(2026, 11, 12, 9, 0, tzinfo=timezone.utc)
MEALS = "### 3.2 Meals\n\nMeals above RM100 are reviewed by HR and may be reimbursed only up to RM100."
HOTELS = "### 3.3 Accommodations\n\nHotel rates depend on your rank. See the table for your nightly hotel limit."
MEAL_RULE = LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=100)
HOTEL_RULE = LimitRule(category="Accommodations", unit=LimitUnit.PER_NIGHT, amount=250, grade_max=2)


def _policy(db, hr, title, effective=NOW, sections=(MEALS, HOTELS)):
    p = Policy(alias=f"Q-{uuid4().hex[:6]}", title=title, effective_date=effective, overview_summary="",
               mandatory_conditions="{}", source_file_url="", status=PolicyStatus.ACTIVE, created_by=hr.user_id)
    db.add(p)
    db.commit()
    for c in ("Meals", "Accommodations"):
        db.add(PolicyReimbursableCategory(policy_id=p.policy_id, category=c))
    for i, content in enumerate(sections):
        db.add(PolicySection(policy_id=p.policy_id, section_order=i, content=content))
    db.commit()
    return p


@pytest.fixture
def setup(pg_db, monkeypatch):
    import engine.tools.rag_tool as rag

    pg_db.exec(text("UPDATE policies SET status = 'DEPRECATED' WHERE status = 'ACTIVE'"))
    pg_db.exec(text("DELETE FROM policy_questions"))  # rolled back; the summary counts every row
    hr = User(email=f"hr-{uuid4().hex[:6]}@t.local", hashed_password="x", name="HR", role=UserRole.HR, rank=5)
    me = User(email=f"e-{uuid4().hex[:6]}@t.local", hashed_password="x", name="Farid", role=UserRole.Employee, rank=2)
    pg_db.add_all([hr, me])
    pg_db.commit()
    p = _policy(pg_db, hr, "Demo travel policy")
    store.confirm_all(pg_db, p.policy_id, [MEAL_RULE, HOTEL_RULE], [], hr.user_id, NOW)
    pg_db.commit()

    def no_embeddings():
        raise RuntimeError("no embeddings in tests")

    monkeypatch.setattr(rag, "get_embeddings", no_embeddings)  # keyword search path
    return pg_db, me, hr, p


def _llm(monkeypatch, payload, seen=None):
    def fake(question, sections, grade, limits):
        if seen is not None:
            seen.update(question=question, sections=sections, grade=grade, limits=limits)
        return payload

    monkeypatch.setattr(qa, "run_qa_llm", fake)


def test_verified_answer_is_returned_and_logged(setup, monkeypatch):
    db, me, _, _ = setup
    seen = {}
    _llm(monkeypatch, {"covered": True, "answer": "Up to RM 100.00 for the meal.",
                       "quote": "may be reimbursed only up to RM100"}, seen)
    out = qa.answer_question(db, me, "Can I claim a client dinner meal?", NOW)
    assert out.covered and out.policy_title == "Demo travel policy" and out.answer.startswith("Up to RM 100.00")
    assert seen["grade"] == 2 and "Accommodations: Up to MYR 250.00 a night" in seen["limits"]
    row = db.exec(text("SELECT covered, section_id, answer FROM policy_questions")).first()
    assert row[0] is True and row[1] is not None and row[2].startswith("Up to")


def test_made_up_quote_becomes_ask_hr(setup, monkeypatch):
    db, me, _, _ = setup
    _llm(monkeypatch, {"covered": True, "answer": "Yes, meals are unlimited.", "quote": "Meals are unlimited for everyone."})
    out = qa.answer_question(db, me, "Is there a cap on meal costs?", NOW)
    assert out.covered is False and out.answer == qa.NOT_COVERED_ANSWER and out.quote is None


def test_covered_must_be_a_real_boolean(setup, monkeypatch):
    db, me, _, _ = setup
    _llm(monkeypatch, {"covered": "false", "answer": "Up to RM100.", "quote": "may be reimbursed only up to RM100"})
    assert qa.answer_question(db, me, "What is the meal limit?", NOW).covered is False


def test_number_from_the_question_passes(setup, monkeypatch):
    db, me, _, _ = setup
    _llm(monkeypatch, {"covered": True, "answer": "A RM120 dinner is above the limit. You can claim up to RM100.",
                       "quote": "may be reimbursed only up to RM100"})
    assert qa.answer_question(db, me, "Can I claim a RM120 dinner meal?", NOW).covered is True


def test_per_unit_amount_from_my_limits_passes(setup, monkeypatch):
    db, me, _, _ = setup
    _llm(monkeypatch, {"covered": True, "answer": "Your hotel limit is MYR 250 a night.",
                       "quote": "Hotel rates depend on your rank."})
    assert qa.answer_question(db, me, "What is my hotel limit per night?", NOW).covered is True


def test_invented_amount_becomes_ask_hr(setup, monkeypatch):
    db, me, _, _ = setup
    _llm(monkeypatch, {"covered": True, "answer": "You can claim up to RM150 for the meal.",
                       "quote": "may be reimbursed only up to RM100"})
    out = qa.answer_question(db, me, "How much can I spend on a meal?", NOW)
    assert out.covered is False and out.answer == qa.NOT_COVERED_ANSWER


def test_computed_total_becomes_ask_hr(setup, monkeypatch):
    db, me, _, _ = setup
    _llm(monkeypatch, {"covered": True, "answer": "Three nights come to RM 750.",
                       "quote": "Hotel rates depend on your rank."})
    out = qa.answer_question(db, me, "How much hotel can I claim for three nights?", NOW)
    assert out.covered is False and out.answer == qa.NOT_COVERED_ANSWER


def test_no_matching_sections_skips_the_llm(setup, monkeypatch):
    db, me, _, _ = setup

    def must_not_run(*a, **k):
        raise AssertionError("LLM called")

    monkeypatch.setattr(qa, "run_qa_llm", must_not_run)
    assert qa.answer_question(db, me, "zzzz qqqq", NOW).covered is False
    assert qa.answer_question(db, me, "Can I claim it?", NOW).covered is False  # only stop words


def test_only_the_policy_claims_use_is_searched(setup, monkeypatch):
    db, me, hr, current = setup
    _policy(db, hr, "Old policy", effective=NOW - timedelta(days=400),
            sections=("### Meals\n\nMeals are unlimited for everyone.",))
    seen = {}
    _llm(monkeypatch, {"covered": False, "answer": "", "quote": None}, seen)
    qa.answer_question(db, me, "Are meals unlimited?", NOW)
    assert seen["sections"] and {s.policy_id for s in seen["sections"]} == {current.policy_id}


def test_daily_cap(setup, monkeypatch):
    db, me, _, _ = setup
    for i in range(qa.DAILY_QUESTION_LIMIT):
        db.add(PolicyQuestion(user_id=me.user_id, question=f"q{i}", created_at=NOW - timedelta(hours=23)))
    db.commit()
    with pytest.raises(qa.QuestionError, match="DAILY_QUESTION_LIMIT"):
        qa.answer_question(db, me, "Another question about meals", NOW)
    _llm(monkeypatch, {"covered": False, "answer": "", "quote": None})
    assert qa.answer_question(db, me, "Another question about meals", NOW + timedelta(hours=2)).covered is False


def test_llm_failure_counts_toward_the_cap_but_is_not_a_policy_gap(setup, monkeypatch):
    db, me, _, _ = setup

    def boom(*a, **k):
        raise RuntimeError("429")

    monkeypatch.setattr(qa, "run_qa_llm", boom)
    with pytest.raises(qa.QuestionError, match="QA_UNAVAILABLE"):
        qa.answer_question(db, me, "What is the meal limit?", NOW)
    assert db.exec(text("SELECT count(*) FROM policy_questions WHERE answer IS NULL")).one()[0] == 1
    s = qa.question_summary(db, NOW + timedelta(minutes=1))
    assert s.total == 1 and s.unanswered == 0 and s.recent_unanswered == []


def test_summary_has_no_names_or_times_and_counts_sections(setup, monkeypatch):
    db, me, _, _ = setup
    _llm(monkeypatch, {"covered": False, "answer": "", "quote": None})
    qa.answer_question(db, me, "Can I claim a gym membership as a meal?", NOW)
    _llm(monkeypatch, {"covered": True, "answer": "Up to RM100.", "quote": "may be reimbursed only up to RM100"})
    qa.answer_question(db, me, "What is the meal limit?", NOW)
    s = qa.question_summary(db, NOW + timedelta(minutes=1))
    assert s.total == 2 and s.unanswered == 1
    assert s.recent_unanswered[0].question.startswith("Can I claim")
    assert s.recent_unanswered[0].asked_on.isoformat() == "2026-11-12"
    assert s.top_sections[0].section == "3.2 Meals" and s.top_sections[0].count == 1
    dumped = s.model_dump_json()
    assert "Farid" not in dumped and str(me.user_id) not in dumped and me.email not in dumped and "09:00" not in dumped


def test_deleting_a_policy_keeps_its_questions(setup, monkeypatch):
    from main import app

    db, me, hr, p = setup
    _llm(monkeypatch, {"covered": True, "answer": "Up to RM100.", "quote": "may be reimbursed only up to RM100"})
    qa.answer_question(db, me, "What is the meal limit?", NOW)
    app.dependency_overrides[deps.get_db] = lambda: db
    app.dependency_overrides[deps.get_current_user] = lambda: hr
    try:
        assert TestClient(app).delete(f"/api/v1/policies/{p.policy_id}").status_code == 200
    finally:
        app.dependency_overrides.clear()
    row = db.exec(text("SELECT covered, section_id, policy_id FROM policy_questions")).first()
    assert row == (True, None, None)


def test_ask_route_maps_errors_and_questions_are_hr_only(setup, monkeypatch):
    from main import app

    db, me, hr, _ = setup
    app.dependency_overrides[deps.get_db] = lambda: db
    app.dependency_overrides[deps.get_current_user] = lambda: me
    try:
        c = TestClient(app)
        assert c.post("/api/v1/spend-check/ask", json={"question": "hi"}).json()["detail"] == "QUESTION_LENGTH"
        _llm(monkeypatch, {"covered": False, "answer": "", "quote": None})
        res = c.post("/api/v1/spend-check/ask", json={"question": "What about meals?"})
        assert res.status_code == 200 and res.json()["answer"] == qa.NOT_COVERED_ANSWER
        assert c.get("/api/v1/spend-check/questions").status_code == 403
        app.dependency_overrides[deps.get_current_user] = lambda: hr
        body = c.get("/api/v1/spend-check/questions").json()
        assert body["total"] >= 1 and "asked_at" not in body["recent_unanswered"][0]
    finally:
        app.dependency_overrides.clear()
