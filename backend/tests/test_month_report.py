"""F12 month-end report: every number comes from SQL, matches the rows behind it, and the
narrative never shows a number that isn't in the metrics."""
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from api import deps
from core.enums import JudgmentResult, PayoutStatus, RecoveryStatus, ReimbursementStatus, UserRole
from core.models import Department, MonthlyReport, Payout, Recovery, Reimbursement, User
from engine.services import month_report as svc

UTC = timezone.utc
MONTH = "2020-10"  # far from any other test data


# ─── Months (pure) ───────────────────────────────────────────────────────────

def test_month_window_uses_malaysia_time():
    start, end = svc.month_window("2026-10")
    assert start == datetime(2026, 9, 30, 16, tzinfo=UTC)
    assert end == datetime(2026, 10, 31, 16, tzinfo=UTC)
    assert svc.month_window("2026-12")[1] == datetime(2026, 12, 31, 16, tzinfo=UTC)


def test_bad_and_future_months():
    with pytest.raises(svc.ReportError):
        svc.parse_month("2026-13")
    with pytest.raises(svc.ReportError):
        svc.parse_month("Oct 2026")
    now = datetime(2026, 11, 12, tzinfo=UTC)
    assert svc.check_reportable("2026-10", now) is True
    assert svc.check_reportable("2026-11", now) is False  # in progress
    with pytest.raises(svc.ReportError):
        svc.check_reportable("2026-12", now)


def test_previous_month_follows_malaysia_time():
    # 1 Nov 00:30 in Malaysia is still 31 Oct in UTC.
    assert svc.previous_month(datetime(2026, 10, 31, 16, 30, tzinfo=UTC)) == "2026-10"
    assert svc.previous_month(datetime(2027, 1, 5, tzinfo=UTC)) == "2026-12"


# ─── Narrative (pure) ────────────────────────────────────────────────────────

METRICS = {
    "month": "2026-10", "label": "October 2026", "timezone": svc.REPORT_TZ_NAME, "currency": "MYR",
    "reimbursed": {"value": 1234.5, "count": 3, "link": ""},
    "by_category": [{"key": "Meals", "value": 1000.0, "count": 2, "link": ""},
                    {"key": "Transport", "value": 234.5, "count": 1, "link": ""}],
    "by_team": [{"key": "Sales", "value": 1234.5, "count": 3, "link": ""}],
    "auto_pay": {"auto": 7, "decided": 8, "rate": 87.5, "link": "", "decided_link": ""},
    "fakes_caught": {"count": 1, "value": 300.0, "link": ""},
    "recovered": {"value": 80.0, "count": 1, "link": ""},
    "breaches": [{"code": "HIGH_RISK_SIGNAL", "count": 2, "link": ""}],
    "other_currency_claims": 0,
}


def test_model_text_with_only_metric_numbers_is_kept():
    text = ("In October 2026, MYR 1,234.50 was reimbursed across 3 claims. Meals led at MYR 1,000.00. "
            "7 of 8 decided claims were paid automatically, an auto-pay rate of 87.5% (about 88%).")
    assert svc.write_narrative(METRICS, llm=lambda m: {"summary": text}) == (text, "model")


def test_invented_number_falls_back_to_the_template():
    text = "MYR 1,234.50 was reimbursed, up 12% on September."  # 12 is not in the metrics
    narrative, source = svc.write_narrative(METRICS, llm=lambda m: {"summary": text})
    assert source == "template"
    assert "12%" not in narrative
    assert "MYR 1,234.50" in narrative


def test_computed_total_is_rejected():
    # 1,234.50 + 80.00 is a number the model worked out, not one in the metrics.
    assert svc.checked_narrative({"summary": "Together that is MYR 1,314.50."}, METRICS) is None


def test_model_failure_and_bad_shapes_use_the_template():
    def boom(_):
        raise RuntimeError("quota")
    assert svc.write_narrative(METRICS, llm=boom)[1] == "template"
    assert svc.write_narrative(METRICS, llm=lambda m: ["not", "a", "dict"])[1] == "template"
    assert svc.write_narrative(METRICS, llm=lambda m: {"summary": ""})[1] == "template"


def test_template_passes_its_own_number_check():
    text = svc.template_narrative(METRICS)
    assert svc.checked_narrative({"summary": text}, METRICS) == text
    assert "87.5%" in text and "MYR 80.00" in text


# ─── Metrics on real rows (needs TEST_DATABASE_URL) ──────────────────────────

def _at(day: int, hour: int = 4, month: int = 10) -> datetime:
    return datetime(2020, month, day, hour, tzinfo=UTC)


@pytest.fixture
def seeded(pg_db):
    db = pg_db
    tag = uuid4().hex[:6]
    sales = Department(name=f"Sales {tag}")
    ops = Department(name=f"Ops {tag}")
    db.add_all([sales, ops])
    db.commit()
    people = {
        "sales": User(email=f"s-{tag}@t.local", hashed_password="x", name="Siti", department_id=sales.department_id),
        "ops": User(email=f"o-{tag}@t.local", hashed_password="x", name="Omar", department_id=ops.department_id),
        "none": User(email=f"n-{tag}@t.local", hashed_password="x", name="Nadia"),
        "hr": User(email=f"h-{tag}@t.local", hashed_password="x", name="Hana HR", role=UserRole.HR),
    }
    db.add_all(people.values())
    db.commit()

    def claim(who, category, amount, status, tier, created, reviewed=None, signals=(), stops=(), currency="MYR"):
        r = Reimbursement(
            user_id=people[who].user_id, main_category=category, currency=currency,
            total_claimed_amount=amount, total_approved_amount=amount if status != ReimbursementStatus.REJECTED else 0,
            judgment=JudgmentResult.APPROVED, summary="t", status=status, tier=tier,
            reviewed_by=people["hr"].user_id if reviewed else None, reviewed_at=reviewed,
            autonomy={"hard_stops": list(stops),
                      "signals": [{"code": c, "severity": s} for c, s in signals]},
            created_at=created, updated_at=created,
        )
        db.add(r)
        db.commit()
        return r

    def payout(r, at, status=PayoutStatus.SUCCEEDED):
        db.add(Payout(reim_id=r.reim_id, user_id=r.user_id, amount=r.total_approved_amount, currency="MYR",
                      status=status, idempotency_key=uuid4().hex, reference_id=uuid4().hex,
                      channel_code="PAYPAL", created_at=at, updated_at=at))
        db.commit()

    P, R, A = ReimbursementStatus.PAID, ReimbursementStatus.REJECTED, ReimbursementStatus.APPROVED
    # Paid in October (Malaysia time):
    a = claim("sales", "Meals", 100, P, "AUTO_PAY", _at(3)); payout(a, _at(3, 5))
    b = claim("sales", "Meals", 50.25, P, "HR_QUICK", _at(4), reviewed=_at(5),
              signals=[("NEAR_THRESHOLD", "LOW")]); payout(b, _at(6))
    c = claim("ops", "Transport", 30, P, "AUTO_PAY", _at(10)); payout(c, _at(10, 6))
    d = claim("none", "Transport", 20, P, "AUTO_PAY", _at(12))  # no payout record: its own update time counts
    # 31 Oct 17:00 UTC is 1 Nov in Malaysia: decided and paid in November, not October.
    e = claim("sales", "Meals", 999, P, "AUTO_PAY", _at(31, 17)); payout(e, _at(31, 17))
    # Created in September but paid in October: paid counts, decision does not.
    f = claim("ops", "Meals", 40, P, "AUTO_PAY", _at(28, month=9)); payout(f, _at(2))
    # A failed payout attempt before the successful one doesn't change the paid time.
    payout(f, _at(29, month=9), status=PayoutStatus.FAILED)
    # Rejected with a HIGH signal: a fake caught.
    g = claim("ops", "Meals", 300, R, "HR_REVIEW", _at(15), reviewed=_at(16),
              signals=[("DUPLICATE_RECEIPT", "HIGH")], stops=["HIGH_RISK_SIGNAL"])
    # Rejected with only a MEDIUM signal: not a fake.
    claim("sales", "Meals", 70, R, "HR_REVIEW", _at(17), reviewed=_at(18), signals=[("NEAR_THRESHOLD", "MEDIUM")])
    # Approved and paid later, then a recovery recovered in October: a fake caught and money recovered.
    h = claim("sales", "Transport", 80, A, "AUTO_PAY", _at(20))
    db.add(Recovery(reim_id=h.reim_id, user_id=h.user_id, amount=80, currency="MYR", reason="personal",
                    status=RecoveryStatus.RECOVERED, dispute_until=_at(25), created_by=people["hr"].user_id,
                    created_at=_at(21), updated_at=_at(26)))
    # Still in review, and a USD claim: neither is counted.
    claim("sales", "Meals", 500, ReimbursementStatus.REVIEW, "HR_REVIEW", _at(22))
    claim("sales", "Meals", 25, P, "AUTO_PAY", _at(23), currency="USD")
    db.commit()
    return db, people, {"a": a, "b": b, "c": c, "d": d, "e": e, "f": f, "g": g, "h": h}


def test_metrics_match_a_hand_count(seeded):
    db, _, _ = seeded
    m = svc.compute_metrics(db, MONTH)
    assert m["label"] == "October 2020"
    # a 100 + b 50.25 + c 30 + d 20 + f 40
    assert m["reimbursed"] == {"value": 240.25, "count": 5, "link": "/hr/history?report=2020-10&metric=reimbursed"}
    assert [(g["key"], g["value"], g["count"]) for g in m["by_category"]] == [("Meals", 190.25, 3), ("Transport", 50.0, 2)]
    teams = {g["key"].split(" ")[0]: (g["value"], g["count"]) for g in m["by_team"]}
    assert teams == {"Sales": (150.25, 2), "Ops": (70.0, 2), "No": (20.0, 1)}
    # Decided in October: a, b, c, d, g, the MEDIUM rejection and h. Auto: a, c, d, h.
    assert {k: m["auto_pay"][k] for k in ("auto", "decided", "rate")} == {"auto": 4, "decided": 7, "rate": 57.1}
    assert m["fakes_caught"]["count"] == 2 and m["fakes_caught"]["value"] == 380.0  # g 300 + h 80
    assert m["recovered"]["value"] == 80.0 and m["recovered"]["count"] == 1
    assert m["breaches"][0]["code"] in {"DUPLICATE_RECEIPT", "HIGH_RISK_SIGNAL", "NEAR_THRESHOLD"}
    assert {b["code"]: b["count"] for b in m["breaches"]} == {
        "NEAR_THRESHOLD": 2, "DUPLICATE_RECEIPT": 1, "HIGH_RISK_SIGNAL": 1}
    assert m["other_currency_claims"] == 1


def test_every_number_adds_up_from_its_rows(seeded):
    db, _, _ = seeded
    m = svc.compute_metrics(db, MONTH)
    rows = svc.claim_rows(db, MONTH, "reimbursed")
    assert svc.total(rows) == m["reimbursed"]["value"] and len(rows) == m["reimbursed"]["count"]
    for g in m["by_category"]:
        rows = svc.claim_rows(db, MONTH, "reimbursed", category=g["key"])
        assert (svc.total(rows), len(rows)) == (g["value"], g["count"])
    for g in m["by_team"]:
        rows = svc.claim_rows(db, MONTH, "reimbursed", team=g["key"])
        assert (svc.total(rows), len(rows)) == (g["value"], g["count"])
    assert len(svc.claim_rows(db, MONTH, "auto_paid")) == m["auto_pay"]["auto"]
    assert len(svc.claim_rows(db, MONTH, "decided")) == m["auto_pay"]["decided"]
    assert len(svc.claim_rows(db, MONTH, "fakes_caught")) == m["fakes_caught"]["count"]
    assert svc.total(svc.claim_rows(db, MONTH, "recovered")) == m["recovered"]["value"]
    for b in m["breaches"]:
        assert len(svc.claim_rows(db, MONTH, "breach", code=b["code"])) == b["count"]


def test_the_boundary_claim_lands_in_november(seeded):
    db, _, claims = seeded
    november = {r.reim_id for r in svc.claim_rows(db, "2020-11", "reimbursed")}
    assert claims["e"].reim_id in november
    assert claims["e"].reim_id not in {r.reim_id for r in svc.claim_rows(db, MONTH, "reimbursed")}


# ─── API ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def client(seeded, monkeypatch):
    from main import app

    db, people, claims = seeded
    monkeypatch.setattr(svc, "run_narrative_llm", lambda m: {"summary": "MYR 999,999.00 was spent."})
    app.dependency_overrides[deps.get_db] = lambda: db
    app.dependency_overrides[deps.get_current_hr_user] = lambda: people["hr"]
    app.dependency_overrides[deps.get_current_user] = lambda: people["hr"]
    try:
        yield TestClient(app), db, claims
    finally:
        app.dependency_overrides.clear()


def test_finished_month_is_stored_and_stays_put(client):
    c, db, _ = client
    first = c.get("/api/v1/reports/monthly", params={"month": MONTH}).json()
    assert first["final"] is True and first["metrics"]["reimbursed"]["value"] == 240.25
    assert first["narrative_source"] == "template"  # the stub's invented number was rejected
    assert "999,999" not in first["narrative"]
    assert db.get(MonthlyReport, MONTH) is not None

    # A late change doesn't move the stored report until someone regenerates it.
    claims = client[2]
    claims["d"].total_approved_amount = 25
    db.add(claims["d"]); db.commit()
    assert c.get("/api/v1/reports/monthly", params={"month": MONTH}).json()["metrics"]["reimbursed"]["value"] == 240.25
    again = c.post(f"/api/v1/reports/monthly/{MONTH}/regenerate").json()
    assert again["metrics"]["reimbursed"]["value"] == 245.25


def test_claims_endpoint_returns_the_rows_and_their_total(client):
    c, _, claims = client
    body = c.get(f"/api/v1/reports/monthly/{MONTH}/claims", params={"metric": "reimbursed", "category": "Transport"}).json()
    assert body["count"] == 2 and body["total"] == 50.0
    assert {x["reim_id"] for x in body["claims"]} == {str(claims["c"].reim_id), str(claims["d"].reim_id)}
    fakes = c.get(f"/api/v1/reports/monthly/{MONTH}/claims", params={"metric": "fakes_caught"}).json()
    assert {x["reim_id"] for x in fakes["claims"]} == {str(claims["g"].reim_id), str(claims["h"].reim_id)}


def test_bad_requests(client):
    c, _, _ = client
    assert c.get("/api/v1/reports/monthly", params={"month": "2020-13"}).status_code == 400
    assert c.get("/api/v1/reports/monthly", params={"month": "2999-01"}).status_code == 400
    assert c.get(f"/api/v1/reports/monthly/{MONTH}/claims", params={"metric": "nope"}).status_code == 400


def test_employees_are_refused(pg_db):
    from main import app

    app.dependency_overrides[deps.get_db] = lambda: pg_db
    try:
        # No HR override: the real dependency rejects a request without an HR token.
        assert TestClient(app).get("/api/v1/reports/monthly").status_code in (401, 403)
    finally:
        app.dependency_overrides.clear()
