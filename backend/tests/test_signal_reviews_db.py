from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlmodel import select

from api import deps
from core.enums import AgentActionType, JudgmentResult, ReimbursementStatus, SignalVerdict, UserRole
from core.models import AgentAction, Reimbursement, SignalReview, User
from engine.risk.types import Severity, SignalCode, make_signal
from engine.services import signal_review_service as svc
from engine.services.action_log import verify_chain

NOW = datetime(2026, 11, 12, 9, 0, tzinfo=timezone.utc)


def _user(db, role=UserRole.HR):
    u = User(email=f"u-{uuid4().hex[:8]}@t.local", hashed_password="x", name="T", role=role)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _claim(db, owner, status=ReimbursementStatus.REVIEW, claimed=120.0, approved=None, reviewed_by=None,
           signals=None, created_at=NOW - timedelta(days=1)):
    if signals is None:
        signals = [make_signal(SignalCode.NO_CAMERA_METADATA, Severity.LOW, "No camera data", document_id="doc-1")]
    r = Reimbursement(
        user_id=owner.user_id, status=status, main_category="Travel", judgment=JudgmentResult.APPROVED,
        summary="", currency="MYR", total_claimed_amount=claimed, total_approved_amount=approved,
        reviewed_by=reviewed_by, created_at=created_at, tier="HR_QUICK", risk_score=5,
        autonomy={"tier": "HR_QUICK", "signals": [s.model_dump(mode="json") for s in signals]},
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


def _in(code="NO_CAMERA_METADATA", doc="doc-1", verdict=SignalVerdict.FALSE_ALARM):
    return svc.SignalReviewIn(signal_code=code, document_id=doc, verdict=verdict)


def _logged(db):
    return db.exec(select(AgentAction).where(AgentAction.action_type == AgentActionType.SIGNAL_REVIEWED)
                   .order_by(AgentAction.action_id)).all()


def test_review_is_upserted_and_each_answer_logged(pg_db):
    pg_db.exec(text("DELETE FROM agent_actions"))
    hr, emp = _user(pg_db), _user(pg_db, UserRole.Employee)
    r = _claim(pg_db, emp)
    svc.record_review(pg_db, r, hr, _in(), NOW)
    svc.record_review(pg_db, r, hr, _in(verdict=SignalVerdict.CONFIRMED), NOW + timedelta(minutes=1))
    rows = svc.reviews_for(pg_db, r.reim_id)
    assert len(rows) == 1 and rows[0].verdict == SignalVerdict.CONFIRMED
    logged = _logged(pg_db)
    assert [a.payload["verdict"] for a in logged] == ["FALSE_ALARM", "CONFIRMED"]
    assert verify_chain(pg_db)


def test_second_reviewer_overwrite_keeps_the_first_answer_in_the_log(pg_db):
    pg_db.exec(text("DELETE FROM agent_actions"))
    first, second, emp = _user(pg_db), _user(pg_db), _user(pg_db, UserRole.Employee)
    r = _claim(pg_db, emp)
    svc.record_review(pg_db, r, first, _in(verdict=SignalVerdict.CONFIRMED), NOW)
    svc.record_review(pg_db, r, second, _in(verdict=SignalVerdict.FALSE_ALARM), NOW)
    row = svc.reviews_for(pg_db, r.reim_id)[0]
    assert row.reviewed_by == second.user_id and row.verdict == SignalVerdict.FALSE_ALARM
    first_log, second_log = _logged(pg_db)
    assert first_log.payload["previous"] is None
    assert second_log.payload["previous"] == {"verdict": "CONFIRMED", "reviewed_by": str(first.user_id)}


def test_review_never_changes_the_decision(pg_db):
    hr, emp = _user(pg_db), _user(pg_db, UserRole.Employee)
    r = _claim(pg_db, emp)
    before = (r.status, r.tier, r.risk_score, r.judgment, dict(r.autonomy), r.total_approved_amount)
    svc.record_review(pg_db, r, hr, _in(verdict=SignalVerdict.CONFIRMED), NOW)
    pg_db.refresh(r)
    assert (r.status, r.tier, r.risk_score, r.judgment, dict(r.autonomy), r.total_approved_amount) == before


def test_cannot_review_a_signal_the_claim_does_not_have(pg_db):
    hr, emp = _user(pg_db), _user(pg_db, UserRole.Employee)
    r = _claim(pg_db, emp)
    with pytest.raises(svc.ReviewError, match="SIGNAL_NOT_ON_CLAIM"):
        svc.record_review(pg_db, r, hr, _in(code="DUPLICATE_RECEIPT"), NOW)
    with pytest.raises(svc.ReviewError, match="SIGNAL_NOT_ON_CLAIM"):
        svc.record_review(pg_db, r, hr, _in(doc="doc-other"), NOW)
    # A document-level signal needs its document: a claim-level label would never match it in the report.
    with pytest.raises(svc.ReviewError, match="SIGNAL_NOT_ON_CLAIM"):
        svc.record_review(pg_db, r, hr, _in(doc=None), NOW)


def test_claim_level_signal_is_reviewed_without_a_document(pg_db):
    hr, emp = _user(pg_db), _user(pg_db, UserRole.Employee)
    r = _claim(pg_db, emp, signals=[make_signal(SignalCode.SPLIT_CLAIM, Severity.MEDIUM, "Split")])
    row = svc.record_review(pg_db, r, hr, _in(code="SPLIT_CLAIM", doc=None), NOW)
    assert row.document_key == "" and svc.to_out(row).document_id is None


def test_cannot_review_your_own_claim(pg_db):
    hr = _user(pg_db)
    r = _claim(pg_db, hr)
    with pytest.raises(svc.ReviewError, match="SELF_REVIEW"):
        svc.record_review(pg_db, r, hr, _in(), NOW)


def _cam(db):
    rows = {q.code: q for q in svc.signal_quality(db, NOW, days=90)}
    return rows.get("NO_CAMERA_METADATA") or svc.SignalQuality(
        code="NO_CAMERA_METADATA", fired=0, confirmed=0, false_alarm=0, unreviewed=0,
        approved_in_full=0, rejected=0, precision=None)


def test_quality_report_counts_reviews_and_outcomes(pg_db):
    hr, emp = _user(pg_db), _user(pg_db, UserRole.Employee)
    before = _cam(pg_db)
    paid = _claim(pg_db, emp, status=ReimbursementStatus.PAID, approved=120.0, reviewed_by=hr.user_id)
    _claim(pg_db, emp, status=ReimbursementStatus.PAID, approved=80.0, reviewed_by=hr.user_id)  # HR cut a line
    _claim(pg_db, emp, status=ReimbursementStatus.REJECTED, approved=0.0, reviewed_by=hr.user_id)
    _claim(pg_db, emp, status=ReimbursementStatus.REJECTED)  # rejected without an HR reviewer
    _claim(pg_db, emp, status=ReimbursementStatus.PAID, approved=120.0)  # AUTO_PAY: no human looked
    _claim(pg_db, emp)  # still in review
    _claim(pg_db, emp, created_at=NOW - timedelta(days=91))  # outside the window
    svc.record_review(pg_db, paid, hr, _in(), NOW)
    after = _cam(pg_db)
    assert after.fired - before.fired == 6
    assert after.false_alarm - before.false_alarm == 1
    assert after.unreviewed - before.unreviewed == 5
    assert after.approved_in_full - before.approved_in_full == 1
    assert after.rejected - before.rejected == 1


def test_routes_are_hr_only_and_map_errors(pg_db):
    from main import app

    hr, emp = _user(pg_db), _user(pg_db, UserRole.Employee)
    r = _claim(pg_db, emp)
    own = _claim(pg_db, hr)
    acting = {"user": hr}
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: acting["user"]
    try:
        c = TestClient(app)
        url = f"/api/v1/reimbursements/{r.reim_id}/signal-reviews"
        body = {"signal_code": "NO_CAMERA_METADATA", "document_id": "doc-1", "verdict": "FALSE_ALARM"}
        ok = c.put(url, json=body)
        assert ok.status_code == 200 and ok.json()["verdict"] == "FALSE_ALARM"
        assert c.get(url).json()[0]["signal_code"] == "NO_CAMERA_METADATA"
        bad = c.put(url, json={"signal_code": "SPLIT_CLAIM", "document_id": None, "verdict": "CONFIRMED"})
        assert bad.status_code == 422 and bad.json()["detail"] == "SIGNAL_NOT_ON_CLAIM"
        mine = c.put(f"/api/v1/reimbursements/{own.reim_id}/signal-reviews", json=body)
        assert mine.status_code == 403 and mine.json()["detail"] == "SELF_REVIEW"
        assert c.get("/api/v1/autonomy/signal-quality").status_code == 200
        assert c.put(f"/api/v1/reimbursements/{uuid4()}/signal-reviews",
                     json={"signal_code": "NO_CAMERA_METADATA", "verdict": "CONFIRMED"}).status_code == 404
        acting["user"] = emp
        assert c.get(url).status_code == 403
        assert c.put(url, json=body).status_code == 403
        assert c.get("/api/v1/autonomy/signal-quality").status_code == 403
    finally:
        app.dependency_overrides.clear()


def test_quality_report_skips_malformed_signals(pg_db):
    emp = _user(pg_db, UserRole.Employee)
    before = _cam(pg_db)
    good = make_signal(SignalCode.NO_CAMERA_METADATA, Severity.LOW, "No camera data", document_id="doc-1")
    for autonomy in (
        {"signals": [None, "NO_CAMERA_METADATA", {}, {"code": None}, good.model_dump(mode="json")]},
        {"signals": {"code": "NO_CAMERA_METADATA"}},
        {"signals": "NO_CAMERA_METADATA"},
    ):
        r = _claim(pg_db, emp)
        r.autonomy = autonomy
        pg_db.add(r)
        pg_db.commit()
    rows = {q.code: q for q in svc.signal_quality(pg_db, NOW, days=90)}
    assert "None" not in rows and "" not in rows
    assert rows["NO_CAMERA_METADATA"].fired - before.fired == 1


def test_a_check_firing_twice_on_one_document_counts_once(pg_db):
    hr, emp = _user(pg_db), _user(pg_db, UserRole.Employee)
    before = _cam(pg_db)
    twice = [make_signal(SignalCode.NO_CAMERA_METADATA, Severity.LOW, "No camera data", document_id="doc-1")] * 2
    r = _claim(pg_db, emp, signals=twice)
    svc.record_review(pg_db, r, hr, _in(), NOW)
    after = _cam(pg_db)
    assert after.fired - before.fired == 1 and after.false_alarm - before.false_alarm == 1

