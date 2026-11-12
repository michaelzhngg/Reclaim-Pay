"""R3 red-team suite: every corpus case goes through the Receipt Shield and decide() the way a real claim does.

Upload: sha256, pHash, EXIF/C2PA inspection and image forensics on the file (document_agent._fingerprint).
Claim: ShieldDoc per receipt, run_shield, observe-mode forensics, then decide() (compliance_agent).
The attacker gets the best case everywhere else: a trusted employee (limit 200), a verified payee,
and an AI reviewer that was fooled into APPROVED at 0.95 confidence. Only the shield stands in the way.

    uv run pytest tests/redteam -q -s     # prints the catch-rate table
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path

import pytest

from engine.risk.autonomy import decide, limit_for, trust_tier
from engine.risk.shield.fingerprint import amount_and_date, phash_file, sha256_file
from engine.risk.shield.forensics import analyze_image
from engine.risk.shield.provenance import inspect_image
from engine.risk.shield.run import ShieldDoc, observed_signals, run_shield
from engine.risk.types import (
    AgentLedger, AutonomyConfig, AutonomyTier, ClaimFacts, ClaimLite, DocFingerprint, EmployeeHistory, PayeeStatus,
    Severity, SignalCode,
)
from engine.tools.change_detector import detect_changes
from tests.redteam.corpus import CASES, CLAIM_ID, FAMILIES, HAVE_DEMO, NOW, Case

BASELINE = json.loads((Path(__file__).parent / "baseline.json").read_text())

CONFIG = AutonomyConfig()
HISTORY = EmployeeHistory(paid_claims=12, confirmed_issues_90d=0, confirmed_issues_180d=0,
                          auto_paid_today=0.0, auto_paid_month=0.0)
PAYEE = PayeeStatus(verified=True, linked_at=NOW - timedelta(days=60), changed_at=None)
LEDGER = AgentLedger(auto_paid_today=0.0, auto_paid_last_hour=0.0, breaker_active=False)


@dataclass(frozen=True)
class Outcome:
    codes: frozenset          # signals run_shield passed to decide()
    observed: frozenset       # observe-mode forensics findings, kept out of decide()
    high: tuple               # codes of HIGH signals
    tier: AutonomyTier
    baseline_tier: AutonomyTier   # the same claim decided with no shield signals


class Lab:
    """Builds files once per session and caches the per-file upload work, which is the slow part."""

    def __init__(self, workdir: Path):
        self.workdir = workdir
        self.files: dict[Path, tuple] = {}
        self.outcomes: dict[str, Outcome] = {}

    def upload(self, path: Path, document_id: str, forensics: bool = True) -> tuple:
        if path not in self.files:
            # document_id only labels the signals; it is re-applied below.
            self.files[path] = (sha256_file(str(path)), phash_file(str(path)), inspect_image(str(path)))
        if forensics and (path, "forensics") not in self.files:
            self.files[path, "forensics"] = analyze_image(str(path))
        sha, phash, stored = self.files[path]
        stored = [s.model_copy(update={"document_id": document_id}) for s in stored]
        return sha, phash, stored, self.files.get((path, "forensics")) if forensics else None

    def run(self, case: Case) -> Outcome:
        if case.id not in self.outcomes:
            self.outcomes[case.id] = self._run(case)
        return self.outcomes[case.id]

    def _run(self, case: Case) -> Outcome:
        docs = []
        for i, up in enumerate(case.uploads):
            doc_id = f"{case.id}#{i}"
            fingerprint, stored, forensics = None, [], None
            if up.image:
                # Forensics runs in observe mode, so it can't change a decision; it is skipped (about 0.3 s an image)
                # only for fakes that don't test it. Honest receipts always get it: a finding on one is a failure.
                needed = case.honest or SignalCode.IMAGE_FORENSICS in case.expect
                sha, phash, stored, forensics = self.upload(up.image.path(self.workdir), doc_id, needed)
                # OCR values, not edits, as compliance_agent._shield_docs does.
                amount, expense_date = amount_and_date(up.extracted)
                fingerprint = DocFingerprint(document_id=doc_id, reim_id=CLAIM_ID, user_id=case.user_id, sha256=sha,
                                             phash=phash, reim_status=None, amount=amount, expense_date=expense_date)
            docs.append(ShieldDoc(document_id=doc_id, extracted=up.extracted, edited=up.edited,
                                  change_summary=detect_changes(up.extracted, up.edited) if up.edited else {},
                                  stored_signals=stored, fingerprint=fingerprint, forensics=forensics))

        candidates = []
        for j, prior in enumerate(case.priors):
            sha, phash, _, _ = self.upload(prior.image.path(self.workdir), f"prior#{j}", forensics=False)
            amount, expense_date = amount_and_date(prior.extracted)
            candidates.append(DocFingerprint(document_id=f"{case.id}-prior#{j}", reim_id=f"prior-claim-{j}",
                                             user_id=prior.user_id, sha256=sha, phash=phash, reim_status=prior.status,
                                             amount=amount, expense_date=expense_date))

        # The claim as submitted: the employee's edits win over the OCR values.
        receipts = [{**u.extracted, **u.edited} for u in case.uploads]
        first = receipts[0]
        amount = round(sum(float(str(r.get("total_amount") or 0).replace("RM", "")) for r in receipts), 2)
        expense_date = amount_and_date({"date": first.get("date")})[1]
        claim = ClaimLite(reim_id=CLAIM_ID, user_id=case.user_id, merchant=first.get("merchant_name") or "",
                          expense_date=expense_date, amount=amount, created_at=NOW, status="REVIEW")

        limit = limit_for(CONFIG, trust_tier(HISTORY))
        signals = run_shield(docs, claim, list(case.recent), candidates, limit, lambda step: None,
                             forensics_mode="observe")
        observed = observed_signals(docs, "observe")
        facts = ClaimFacts(reim_id=CLAIM_ID, user_id=case.user_id, amount=amount, currency="MYR", judgment="APPROVED",
                           confidence=0.95, over_category_budget=False, claimant_is_hr=False)
        decision = decide(facts, signals, HISTORY, PAYEE, LEDGER, CONFIG, NOW)
        baseline = decide(facts, [], HISTORY, PAYEE, LEDGER, CONFIG, NOW)
        return Outcome(
            codes=frozenset(s.code for s in signals),
            observed=frozenset(s.code for s in observed),
            high=tuple(sorted(s.code.value for s in signals if s.severity == Severity.HIGH)),
            tier=decision.tier,
            baseline_tier=baseline.tier,
        )


def problems(case: Case, out: Outcome) -> list[str]:
    """Why the shield got this case wrong; empty when it got it right."""
    found = out.codes | out.observed
    if case.honest:
        issues = []
        if out.high:
            issues.append(f"HIGH signal(s) {list(out.high)}")
        if out.observed:
            issues.append("image forensics flagged an honest image")
        if out.tier != out.baseline_tier:
            issues.append(f"lane moved {out.baseline_tier.value} -> {out.tier.value} ({sorted(c.value for c in out.codes)})")
        return issues
    issues = []
    missing = case.expect - found
    if missing:
        issues.append(f"missing {sorted(c.value for c in missing)} (raised: {sorted(c.value for c in found) or 'none'})")
    if case.blocks_auto_pay and out.tier == AutonomyTier.AUTO_PAY:
        issues.append("claim would be AUTO_PAY")
    return issues


@pytest.fixture(scope="session")
def lab(tmp_path_factory) -> Lab:
    return Lab(tmp_path_factory.mktemp("redteam"))


def _param(case: Case):
    marks = []
    if case.needs_demo:
        marks.append(pytest.mark.skipif(not HAVE_DEMO, reason="demo receipts not present"))
    if case.gap:
        marks.append(pytest.mark.xfail(strict=True, raises=AssertionError, reason=case.gap))
    return pytest.param(case, id=case.id, marks=marks)


@pytest.mark.parametrize("case", [_param(c) for c in CASES])
def test_case(lab, case):
    out = lab.run(case)
    issues = problems(case, out)
    assert not issues, f"{case.id} ({case.what}): " + "; ".join(issues)


def test_corpus_is_well_formed(lab):
    ids = [c.id for c in CASES]
    assert len(ids) == len(set(ids)), "case ids must be unique"
    for case in CASES:
        assert case.family in FAMILIES, case.id
        assert case.honest or case.expect, f"{case.id}: a fake must name the signal(s) it expects"
        assert case.gap is None or case.gap.startswith("known gap:" if not case.honest else "false positive:"), case.id
        if case.blocks_auto_pay and not (case.needs_demo and not HAVE_DEMO):
            # Otherwise the case proves nothing: something other than the shield would already stop it.
            out = lab.run(case)
            assert out.baseline_tier == AutonomyTier.AUTO_PAY, f"{case.id}: would not auto-pay even without signals"
    assert set(BASELINE["min_catch_rate"]) == {f for f in FAMILIES if any(not c.honest for c in CASES if c.family == f)}


def summary(lab: Lab) -> tuple[str, list[str]]:
    """The catch-rate table, and the reasons it falls short of baseline.json (empty when it doesn't)."""
    header = f"{'family':<11} {'fakes':>5} {'caught':>6} {'must-catch':>10} {'rate':>5} {'gaps':>4} {'honest':>6} {'FP':>3}"
    rows, failures, slipped = [], [], []
    sums = dict(fakes=0, caught=0, must=0, must_caught=0, honest=0, fp=0)

    def row(name, fakes, caught, must, must_caught, honest, fp):
        rate = f"{caught / fakes:.0%}" if fakes else "-"
        return (f"{name:<11} {fakes:>5} {caught:>6} {f'{must_caught}/{must}':>10} {rate:>5} {fakes - must:>4}"
                f" {honest:>6} {fp:>3}")

    for family in FAMILIES:
        fakes = [c for c in CASES if c.family == family and not c.honest]
        honest = [c for c in CASES if c.family == family and c.honest]
        caught = {c.id for c in fakes if not problems(c, lab.run(c))}
        must = [c for c in fakes if not c.gap]
        slipped += [c.id for c in must if c.id not in caught]
        counts = dict(fakes=len(fakes), caught=len(caught), must=len(must),
                      must_caught=sum(c.id in caught for c in must), honest=len(honest),
                      fp=sum(bool(problems(c, lab.run(c))) for c in honest))
        rows.append(row(family, **counts))
        sums = {k: sums[k] + counts[k] for k in sums}
        floor = BASELINE["min_catch_rate"].get(family)
        if fakes and floor is not None and len(caught) / len(fakes) + 1e-9 < floor:
            failures.append(f"{family}: catch rate {len(caught) / len(fakes):.1%} is below the baseline {floor:.1%}")
    if slipped:
        failures.append(f"must-catch fakes that got through: {', '.join(slipped)}")
    if sums["fp"] > BASELINE["max_false_positives"]:
        failures.append(f"{sums['fp']} honest receipts flagged; the baseline allows {BASELINE['max_false_positives']}")
    table = "\n".join(["Receipt Shield red-team catch rate", header, *rows, "-" * len(header), row("total", **sums)])
    return table, failures


@pytest.mark.skipif(not HAVE_DEMO, reason="demo receipts not present")
def test_catch_rate_at_or_above_baseline(lab):
    table, failures = summary(lab)
    print("\n" + table)
    assert not failures, "\n".join(failures) + "\n\n" + table
