import json
import logging
import re
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest
import respx
from sqlmodel import select

from core import email_service
from core.config import settings
from core.enums import PayoutStatus, RecoveryStatus, ReimbursementStatus, UserRole
from core.models import Notification, Payout, Recovery, Reimbursement, User
from engine.risk.types import TrustTier
from engine.services import payout_service, reminder_service
from engine.services.payout_status import apply_item_update
from engine.services.recovery_service import claim_ref, dispute_recovery, execute_recovery
from engine.services.reminder_service import REMINDER_TITLE, reminder_message, send_dispute_reminders
from engine.services.trust_notices import limit_notice

FAKE_KEY = "re_test_not_a_real_key"
NOW = datetime(2026, 11, 12, 6, 0, tzinfo=timezone.utc)


# Email service

@pytest.fixture
def resend(monkeypatch):
    monkeypatch.setattr(settings, "RESEND_API_KEY", FAKE_KEY)
    monkeypatch.setattr(settings, "EMAIL_FROM", "Reclaim Pay <onboarding@resend.dev>")
    monkeypatch.setattr(settings, "FRONTEND_PUBLIC_URL", "https://reclaimai.dev")
    with respx.mock(assert_all_called=False) as router:
        yield router


def test_no_key_sends_nothing(monkeypatch, caplog):
    monkeypatch.setattr(settings, "RESEND_API_KEY", "")
    monkeypatch.setattr(email_service, "_no_key_logged", False)
    with respx.mock(assert_all_called=False) as router:
        route = router.post(email_service.RESEND_URL)
        with caplog.at_level(logging.INFO, logger="core.email_service"):
            assert email_service.send_email_sync("a@example.com", "Subject", "Body") is False
            email_service.fire_and_forget_email("a@example.com", "Subject", "Body")
    assert not route.called
    assert sum("RESEND_API_KEY is not set" in r.message for r in caplog.records) == 1


def test_payload_shape(resend):
    route = resend.post(email_service.RESEND_URL).mock(return_value=httpx.Response(200, json={"id": "e1"}))
    assert email_service.send_email_sync("emp@example.com", "Payment received", "MYR 30.00 arrived <today>",
                                         link="/employee/history?id=1") is True
    request = route.calls.last.request
    assert request.headers["Authorization"] == f"Bearer {FAKE_KEY}"
    body = json.loads(request.content)
    assert body["from"] == "Reclaim Pay <onboarding@resend.dev>"
    assert body["to"] == ["emp@example.com"]
    assert body["subject"] == "Payment received"
    assert body["text"] == "MYR 30.00 arrived <today>\n\nOpen Reclaim Pay: https://reclaimai.dev/employee/history?id=1"
    assert "&lt;today&gt;" in body["html"] and 'href="https://reclaimai.dev/employee/history?id=1"' in body["html"]


def test_http_error_is_logged_not_raised(resend, caplog):
    resend.post(email_service.RESEND_URL).mock(
        return_value=httpx.Response(422, json={"name": "validation_error", "message": "Invalid `to` field."}))
    with caplog.at_level(logging.WARNING, logger="core.email_service"):
        assert email_service.send_email_sync("bad", "S", "B") is False
    text = " ".join(r.getMessage() for r in caplog.records)
    assert "422" in text and "Invalid `to` field." in text and FAKE_KEY not in text


def test_transport_error_is_logged_not_raised(resend, caplog):
    resend.post(email_service.RESEND_URL).mock(side_effect=httpx.ConnectTimeout("slow"))
    with caplog.at_level(logging.WARNING, logger="core.email_service"):
        assert email_service.send_email_sync("a@example.com", "S", "B") is False
    assert FAKE_KEY not in " ".join(r.getMessage() for r in caplog.records)


# Database helpers

def _user(db, role=UserRole.Employee, name="emp"):
    u = User(email=f"{name}-{uuid4().hex[:8]}@test.local", hashed_password="x", name=name, role=role)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _claim(db, owner, status=ReimbursementStatus.PAID, amount=40.0, days_ago=10):
    at = datetime.now(timezone.utc) - timedelta(days=days_ago)
    r = Reimbursement(user_id=owner.user_id, main_category="Meals", currency="MYR", total_claimed_amount=amount,
                      total_approved_amount=amount, judgment="APPROVED", summary="Lunch", status=status,
                      created_at=at, updated_at=at)
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


def _recovery(db, claim, hr, status=RecoveryStatus.NOTICE_SENT, created=None, until=None, amount=30.0):
    now = datetime.now(timezone.utc)
    rec = Recovery(reim_id=claim.reim_id, user_id=claim.user_id, amount=amount, currency="MYR", reason="Duplicate",
                   status=status.value, dispute_until=until or now + timedelta(hours=12),
                   created_by=hr.user_id, created_at=created or now - timedelta(days=4), updated_at=now)
    db.add(rec)
    db.commit()
    db.refresh(rec)
    return rec


@pytest.fixture
def outbox(pg_db, monkeypatch):
    sent = []
    monkeypatch.setattr(payout_service, "fire_and_forget_push", lambda *a, **k: None)
    monkeypatch.setattr(payout_service, "fire_and_forget_email",
                        lambda to, subject, text, link=None: sent.append((to, subject, text, link)))
    return sent


def _notes(db, user, title_part):
    return [n for n in db.exec(select(Notification).where(Notification.user_id == user.user_id)).all()
            if title_part in n.title]


# notify() email channel

def test_notify_emails_employees_only_when_asked(pg_db, outbox):
    emp, hr = _user(pg_db), _user(pg_db, UserRole.HR, "hr")
    payout_service.notify(pg_db, emp.user_id, "info", "With email", "Body", email=True)
    payout_service.notify(pg_db, emp.user_id, "info", "Without email", "Body")
    payout_service.notify(pg_db, hr.user_id, "info", "HR event", "Body", email=True)
    assert [(to, subject) for to, subject, _, _ in outbox] == [(emp.email, "With email")]


def test_overpayment_notice_is_emailed(pg_db, outbox):
    from engine.services.recovery_service import create_recovery
    emp, hr = _user(pg_db), _user(pg_db, UserRole.HR, "hr")
    claim = _claim(pg_db, emp)
    create_recovery(pg_db, claim, Decimal("30.00"), "Duplicate", hr, datetime.now(timezone.utc))
    assert [s for _, s, _, _ in outbox] == ["Overpayment notice"]


# Dispute reminder

def test_due_recovery_gets_exactly_one_reminder(pg_db, outbox):
    emp, hr = _user(pg_db), _user(pg_db, UserRole.HR, "hr")
    rec = _recovery(pg_db, _claim(pg_db, emp), hr)
    assert send_dispute_reminders(pg_db) == 1
    assert send_dispute_reminders(pg_db) == 0
    notes = _notes(pg_db, emp, REMINDER_TITLE)
    assert len(notes) == 1 and notes[0].message == reminder_message(rec)
    assert claim_ref(rec.reim_id) in notes[0].message and "MYR 30.00" in notes[0].message
    assert [s for _, s, _, _ in outbox] == [REMINDER_TITLE]


@pytest.mark.parametrize("status", [RecoveryStatus.DISPUTED, RecoveryStatus.WAIVED, RecoveryStatus.OFFSET])
def test_closed_or_disputed_recovery_gets_none(pg_db, outbox, status):
    emp, hr = _user(pg_db), _user(pg_db, UserRole.HR, "hr")
    _recovery(pg_db, _claim(pg_db, emp), hr, status=status)
    assert send_dispute_reminders(pg_db) == 0
    assert _notes(pg_db, emp, REMINDER_TITLE) == [] and outbox == []


def test_no_reminder_too_early_too_late_or_for_short_windows(pg_db, outbox):
    emp, hr = _user(pg_db), _user(pg_db, UserRole.HR, "hr")
    now = datetime.now(timezone.utc)
    _recovery(pg_db, _claim(pg_db, emp), hr, until=now + timedelta(hours=30))
    _recovery(pg_db, _claim(pg_db, emp), hr, until=now - timedelta(minutes=5))
    _recovery(pg_db, _claim(pg_db, emp), hr, created=now - timedelta(hours=2), until=now + timedelta(hours=20))
    assert send_dispute_reminders(pg_db) == 0


# Instant-payout limit changes

def _pay_through_webhook(db, claim):
    claim.status = ReimbursementStatus.DISBURSING
    db.add(claim)
    payout = Payout(reim_id=claim.reim_id, user_id=claim.user_id, amount=claim.total_approved_amount,
                    currency="MYR", status=PayoutStatus.ACCEPTED, provider="PAYPAL", attempt=1,
                    provider_item_id=f"I-{uuid4().hex[:10]}", idempotency_key=uuid4().hex,
                    reference_id=claim_ref(claim.reim_id), channel_code="PAYPAL")
    db.add(payout)
    db.commit()
    apply_item_update(db, payout.provider_item_id, str(claim.reim_id), "SUCCESS")


def test_third_paid_claim_earns_silver(pg_db, outbox):
    emp = _user(pg_db)
    _claim(pg_db, emp)
    _claim(pg_db, emp)
    _pay_through_webhook(pg_db, _claim(pg_db, emp, status=ReimbursementStatus.APPROVED))
    notes = _notes(pg_db, emp, "badge")
    assert [(n.title, n.message, n.link) for n in notes] == [
        ("Silver badge earned", "You earned the Silver badge: instant payouts up to MYR 100.", "/employee/dashboard")]
    assert "Silver badge earned" in [s for _, s, _, _ in outbox]


def test_paid_claim_without_tier_change_sends_no_notice(pg_db, outbox):
    emp = _user(pg_db)
    _pay_through_webhook(pg_db, _claim(pg_db, emp, status=ReimbursementStatus.APPROVED))
    assert _notes(pg_db, emp, "badge") == [] and _notes(pg_db, emp, "limit") == []
    assert [s for _, s, _, _ in outbox] == [f"Payment received for claim {claim_ref(_last_claim(pg_db, emp))}"]


def _last_claim(db, emp):
    return db.exec(select(Reimbursement.reim_id).where(Reimbursement.user_id == emp.user_id)).first()


@pytest.fixture
def silver_with_recovery(pg_db, outbox, monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", True)
    emp, hr = _user(pg_db), _user(pg_db, UserRole.HR, "hr")
    overpaid = _claim(pg_db, emp)
    _claim(pg_db, emp)
    _claim(pg_db, emp)
    _claim(pg_db, emp, status=ReimbursementStatus.APPROVED, amount=80.0, days_ago=1)
    rec = _recovery(pg_db, overpaid, hr, created=datetime.now(timezone.utc) - timedelta(days=6),
                    until=datetime.now(timezone.utc) - timedelta(days=1))
    return emp, hr, overpaid, rec


async def test_resolved_recovery_lowers_the_limit(pg_db, silver_with_recovery):
    emp, hr, overpaid, rec = silver_with_recovery
    await execute_recovery(pg_db, rec.recovery_id, hr, datetime.now(timezone.utc))
    notes = _notes(pg_db, emp, "Instant-payout limit")
    assert [n.message for n in notes] == [
        f"Your instant-payout limit is now MYR 50 after a correction on claim {claim_ref(overpaid.reim_id)}."]


def test_disputed_recovery_does_not_lower_the_limit(pg_db, silver_with_recovery):
    emp, hr, overpaid, rec = silver_with_recovery
    rec.dispute_until = datetime.now(timezone.utc) + timedelta(days=1)
    pg_db.add(rec)
    pg_db.commit()
    dispute_recovery(pg_db, rec, emp, "I paid for this myself", datetime.now(timezone.utc))
    assert _notes(pg_db, emp, "Instant-payout limit") == [] and _notes(pg_db, emp, "badge") == []


# Copy

def test_limit_copy():
    assert limit_notice(TrustTier.NEW, TrustTier.STANDARD, "MYR", 100.0, None)[1:] == (
        "Silver badge earned", "You earned the Silver badge: instant payouts up to MYR 100.")
    assert limit_notice(TrustTier.STANDARD, TrustTier.TRUSTED, "MYR", 200.0, None)[2] == (
        "You earned the Gold badge: instant payouts up to MYR 200.")
    assert limit_notice(TrustTier.STANDARD, TrustTier.NEW, "MYR", 50.0, None)[2] == (
        "Your instant-payout limit is now MYR 50.")


_FORBIDDEN = re.compile(r"\b(risk|score|signal|flag|flagged|check|checks|checked)\b", re.IGNORECASE)


def test_new_copy_names_no_check_signal_or_score():
    reim_id = uuid4()
    rec = Recovery(reim_id=reim_id, user_id=uuid4(), amount=30, currency="MYR", reason="x",
                   status="NOTICE_SENT", dispute_until=NOW, created_by=uuid4())
    copy = [REMINDER_TITLE, reminder_message(rec)]
    tiers = list(TrustTier)
    for before in tiers:
        for after in tiers:
            if before != after:
                copy += list(limit_notice(before, after, "MYR", 100.0, reim_id)[1:])
    payload = email_service.build_payload("a@example.com", copy[0], copy[1], link="/employee/dashboard")
    copy += [payload["text"], payload["html"]]
    for text in copy:
        assert not _FORBIDDEN.search(text), text
        assert "\u2014" not in text
    for before in tiers:
        for after in tiers:
            if before != after:
                assert "disput" not in " ".join(limit_notice(before, after, "MYR", 100.0, reim_id)).lower()


def test_email_shows_the_amount_large_with_only_the_figure_bold():
    payload = email_service.build_payload(
        "emp@example.com", "Payment received", "MYR 1,250.00 arrived in your PayPal account for claim RC-1A2B3C4D.")
    assert email_service.headline_amount(payload["text"]) == ("MYR", "1,250.00")
    html = payload["html"]
    assert 'font-weight:400;color:#5c5c72;vertical-align:middle">MYR</span>' in html
    assert 'font-weight:700;letter-spacing:-0.5px;color:#0b0b1e;vertical-align:middle">1,250.00</span>' in html


def test_email_without_an_amount_has_no_amount_block():
    payload = email_service.build_payload("emp@example.com", "Set up your Reclaim Pay account",
                                          "HR created a Reclaim Pay account for you.", link="/set-password?token=x")
    assert email_service.headline_amount(payload["text"].split("\n\n")[0]) is None
    assert "font-size:34px" not in payload["html"]
