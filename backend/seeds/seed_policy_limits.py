"""Write confirmed spending limits for an uploaded policy without an LLM call.

    docker compose exec backend python -m seeds.seed_policy_limits --alias RP-DEMO-2026

Use it when limit extraction at upload failed or the LLM quota ran out before a demo.
Only limits whose category exists on the policy are written. It replaces every limit
row of that policy, including any HR already confirmed.
"""
import argparse
from datetime import datetime, timezone

from sqlmodel import Session, select

from core.database import engine
from core.models import Policy, PolicyReimbursableCategory
from engine.policy.limits import same_category
from engine.policy.samples import DEMO_RULES, DEMO_ZONES
from engine.services import policy_limits_store as store


def seed(db: Session, alias: str = "RP-DEMO-2026", now: datetime | None = None) -> int:
    policy = db.exec(select(Policy).where(Policy.alias == alias)).first()
    if policy is None:
        raise SystemExit(f"No policy with alias {alias}. Upload it in Policy Studio first.")
    categories = db.exec(select(PolicyReimbursableCategory.category)
                         .where(PolicyReimbursableCategory.policy_id == policy.policy_id)).all()
    rules = []
    for rule in DEMO_RULES:
        match = next((c for c in categories if same_category(c, rule.category)), None)
        if match:
            rules.append(rule.model_copy(update={"category": match}))
    store.confirm_all(db, policy.policy_id, rules, DEMO_ZONES, policy.created_by,
                      now or datetime.now(timezone.utc))
    return len(rules)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--alias", default="RP-DEMO-2026")
    args = parser.parse_args()
    with Session(engine) as db:
        print(f"Wrote {seed(db, alias=args.alias)} confirmed limits for {args.alias}.")


if __name__ == "__main__":
    main()
