"""R2 image forensics: honest demo receipts stay clean, typed-over totals are found, and observe mode can't move a decision."""

from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageDraw, ImageFont

from engine.risk.autonomy import decide
from engine.risk.shield.forensics import analyze_image, forensics_signal
from engine.risk.shield.run import ShieldDoc, observed_signals, run_shield
from engine.risk.timeline import employee_safe
from engine.risk.types import (
    AgentLedger, AutonomyConfig, ClaimFacts, ClaimLite, EmployeeHistory, PayeeStatus, Severity, SignalCode,
)

RECEIPTS = Path(__file__).resolve().parents[3] / "demo" / "receipts"
HONEST = ["s1_ride.jpg", "s2_hotel.jpg", "s4_injection.jpg", "s6_meal_a.jpg", "s6_meal_b.jpg", "s8_breakfast.jpg"]
# Every other demo file must stay clean too: none of them is an edited photo.
OTHER_DEMO = ["s3_ai_hotel.png", "s4_injection_visible.jpg", "s5_dup.jpg"]
# Where s1_ride.jpg prints "48.00" on its TOTAL line.
TOTAL_BOX = (600, 938, 728, 990)
NOW = datetime(2026, 11, 3, 10, tzinfo=timezone.utc)

needs_demo = pytest.mark.skipif(not (RECEIPTS / "s1_ride.jpg").exists(), reason="demo receipts not present")

FINDING = {
    "flagged": True, "score": 71, "reason": "One area of the image has much less camera noise than the paper around it.",
    "regions": [{"x": 0.68, "y": 0.71, "w": 0.13, "h": 0.04, "method": "noise"}], "checks": {}, "ms": 100, "version": 1,
}


def _font(size=30):
    for path in ("/usr/share/fonts/dejavu-sans-mono-fonts/DejaVuSansMono-Bold.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
                 "/usr/share/fonts/dejavu/DejaVuSansMono-Bold.ttf", "/usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf"):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default(size)


def typed_over_total(out: Path, quality: int) -> Path:
    """s1_ride.jpg with its total painted over in paper colour and "148.00" typed in, then saved as JPEG again."""
    img = Image.open(RECEIPTS / "s1_ride.jpg").convert("RGB")
    paper = tuple(int(v) for v in np.asarray(img.crop((560, 900, 600, 930))).reshape(-1, 3).mean(axis=0))
    draw = ImageDraw.Draw(img)
    draw.rectangle(TOTAL_BOX, fill=paper)
    draw.text((612, 945), "148.00", font=_font(), fill=(30, 30, 34))
    path = out / f"typed_q{quality}.jpg"
    img.save(path, "JPEG", quality=quality)
    return path


# ─── Detector ────────────────────────────────────────────────────────────────

@needs_demo
@pytest.mark.parametrize("name", HONEST + OTHER_DEMO)
def test_demo_receipts_are_not_flagged(name):
    finding = analyze_image(str(RECEIPTS / name))
    assert finding is not None and finding["flagged"] is False and finding["regions"] == []


@needs_demo
@pytest.mark.parametrize("quality", [60, 75, 90])
@pytest.mark.parametrize("width", [900, 1200])
def test_resized_and_resaved_honest_receipt_is_not_flagged(tmp_path, quality, width):
    # A chat app or phone gallery re-encodes the whole photo; that alone must not look like an edit.
    img = Image.open(RECEIPTS / "s1_ride.jpg")
    path = tmp_path / "copy.jpg"
    img.resize((width, round(width * img.height / img.width))).save(path, "JPEG", quality=quality)
    assert analyze_image(str(path))["flagged"] is False


@needs_demo
@pytest.mark.parametrize("quality", [75, 88, 95])
def test_typed_over_total_is_flagged_where_the_total_is(tmp_path, quality):
    finding = analyze_image(str(typed_over_total(tmp_path, quality)))
    assert finding["flagged"] is True and finding["score"] >= 50 and finding["reason"]
    w, h = 900, 1333
    region = finding["regions"][0]
    cx, cy = (region["x"] + region["w"] / 2) * w, (region["y"] + region["h"] / 2) * h
    assert TOTAL_BOX[0] - 20 <= cx <= TOTAL_BOX[2] + 20 and TOTAL_BOX[1] - 20 <= cy <= TOTAL_BOX[3] + 20


@needs_demo
def test_sideways_phone_photo_reports_the_region_upright(tmp_path):
    # Phones often store a portrait photo sideways with EXIF Orientation=6 (turn 90° clockwise to view).
    # The region must be reported where HR sees it on the upright image.
    upright = Image.open(typed_over_total(tmp_path, 88))
    sideways = upright.transpose(Image.Transpose.ROTATE_90)
    exif = Image.Exif()
    exif[0x0112] = 6
    path = tmp_path / "sideways.jpg"
    sideways.save(path, "JPEG", quality=95, exif=exif)
    finding = analyze_image(str(path))
    assert finding["flagged"] is True
    w, h = upright.size
    region = finding["regions"][0]
    cx, cy = (region["x"] + region["w"] / 2) * w, (region["y"] + region["h"] / 2) * h
    assert TOTAL_BOX[0] - 20 <= cx <= TOTAL_BOX[2] + 20 and TOTAL_BOX[1] - 20 <= cy <= TOTAL_BOX[3] + 20


def test_skips_oversized_images(tmp_path, monkeypatch):
    import engine.risk.shield.forensics as forensics
    monkeypatch.setattr(forensics, "MAX_PIXELS", 300 * 300)
    big = tmp_path / "big.jpg"
    Image.new("RGB", (400, 400), (240, 240, 240)).save(big, "JPEG")
    assert analyze_image(str(big)) is None


def test_skips_what_it_cannot_judge(tmp_path):
    tiny = tmp_path / "tiny.jpg"
    Image.new("RGB", (120, 120), (240, 240, 240)).save(tiny, "JPEG")
    pdf = tmp_path / "r.pdf"
    pdf.write_bytes(b"%PDF-1.4\n%%EOF\n")
    junk = tmp_path / "junk.jpg"
    junk.write_bytes(b"not an image")
    assert analyze_image(str(tiny)) is None
    assert analyze_image(str(pdf)) is None
    assert analyze_image(str(junk)) is None
    assert analyze_image(str(tmp_path / "missing.jpg")) is None


def test_flat_png_screenshot_is_not_flagged(tmp_path):
    # A clean screenshot is flat everywhere, so no block stands out from the rest.
    shot = Image.new("RGB", (800, 1000), (255, 255, 255))
    ImageDraw.Draw(shot).text((40, 40), "TOTAL RM 48.00", font=_font(), fill=(0, 0, 0))
    path = tmp_path / "shot.png"
    shot.save(path)
    finding = analyze_image(str(path))
    assert finding is not None and finding["flagged"] is False and finding["checks"]["ela"] == "skipped"


# ─── Signal by mode ──────────────────────────────────────────────────────────

def test_observe_signal_is_zero_points_and_never_high():
    s = forensics_signal(FINDING, "d1", "observe")
    assert s.code == SignalCode.IMAGE_FORENSICS and s.points == 0 and s.severity == Severity.LOW
    assert s.evidence["scored"] is False and s.evidence["regions"] == FINDING["regions"]


def test_score_signal_is_medium():
    s = forensics_signal(FINDING, "d1", "score")
    assert s.severity == Severity.MEDIUM and s.points == 20 and s.evidence["scored"] is True


@pytest.mark.parametrize("mode", ["off", "observe", "score", "bogus"])
def test_no_signal_without_a_flag(mode):
    assert forensics_signal({**FINDING, "flagged": False}, "d1", mode) is None
    assert forensics_signal(None, "d1", mode) is None


def test_off_mode_gives_nothing():
    assert forensics_signal(FINDING, "d1", "off") is None


# ─── Observe mode can't change a decision ────────────────────────────────────

def _claim():
    return ClaimLite(reim_id="r1", user_id="u1", merchant="Lintas", expense_date=None, amount=48.0,
                     created_at=NOW, status="REVIEW")


def _decide(signals):
    facts = ClaimFacts(reim_id="11111111-1111-1111-1111-111111111111", user_id="u1", amount=48.0, currency="MYR",
                       judgment="APPROVED", confidence=0.95, over_category_budget=False, claimant_is_hr=False)
    history = EmployeeHistory(paid_claims=5, confirmed_issues_90d=0, confirmed_issues_180d=0,
                              auto_paid_today=0.0, auto_paid_month=0.0)
    payee = PayeeStatus(verified=True, linked_at=NOW - timedelta(days=30), changed_at=None)
    ledger = AgentLedger(auto_paid_today=0.0, auto_paid_last_hour=0.0, breaker_active=False)
    return decide(facts, signals, history, payee, ledger, AutonomyConfig(), NOW)


def _shield(doc, mode):
    steps = []
    return run_shield([doc], _claim(), [], [], 100.0, steps.append, forensics_mode=mode), steps


def test_observe_mode_decision_is_identical_with_and_without_a_finding():
    clean, clean_steps = _shield(ShieldDoc(document_id="d1"), "observe")
    flagged_doc = ShieldDoc(document_id="d1", forensics=FINDING)
    flagged, flagged_steps = _shield(flagged_doc, "observe")

    assert flagged == clean
    assert flagged_steps == clean_steps
    assert _decide(flagged).model_dump() == _decide(clean).model_dump()
    assert _decide(clean).tier.value == "AUTO_PAY"
    # HR still gets the finding, as a zero-point observation outside the decision.
    observed = observed_signals([flagged_doc], "observe")
    assert [s.code for s in observed] == [SignalCode.IMAGE_FORENSICS] and observed[0].points == 0


def test_score_mode_adds_a_medium_signal_never_a_hard_stop():
    signals, _ = _shield(ShieldDoc(document_id="d1", forensics=FINDING), "score")
    assert [(s.code, s.severity) for s in signals] == [(SignalCode.IMAGE_FORENSICS, Severity.MEDIUM)]
    decision = _decide(signals)
    assert "HIGH_RISK_SIGNAL" not in [h.value for h in decision.hard_stops]
    assert observed_signals([ShieldDoc(document_id="d1", forensics=FINDING)], "score") == []


def test_off_mode_ignores_stored_findings():
    signals, _ = _shield(ShieldDoc(document_id="d1", forensics=FINDING), "off")
    assert signals == []
    assert observed_signals([ShieldDoc(document_id="d1", forensics=FINDING)], "off") == []


def test_employee_never_sees_it():
    _, steps = _shield(ShieldDoc(document_id="d1", forensics=FINDING), "score")
    safe = [employee_safe(s) for s in steps]
    assert all(s.detail is None and s.status in ("running", "done") for s in safe)
    from api.reimbursements import _employee_autonomy

    record = {**_decide([]).model_dump(mode="json"),
              "observations": [forensics_signal(FINDING, "d1", "observe").model_dump(mode="json")]}
    assert "observations" not in _employee_autonomy(record) and "signals" not in _employee_autonomy(record)
