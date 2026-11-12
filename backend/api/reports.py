"""Month-end report for finance (F12). HR only.

A finished month's report is stored on first view so the numbers finance read don't shift later;
Regenerate rebuilds it. The current month is computed fresh on every view and never stored.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session

from api import deps
from api.reimbursements import _build_reimbursement_response, _list_context
from core.models import MonthlyReport, Reimbursement, User
from engine.services import month_report as svc

router = APIRouter()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _out(month: str, metrics: dict, narrative: str, source: str, generated_at: datetime,
         generated_by: Optional[str], final: bool) -> dict:
    return {
        "month": month,
        "final": final,
        "metrics": metrics,
        "narrative": narrative,
        "narrative_source": source,
        "generated_at": generated_at.isoformat(),
        "generated_by": generated_by,
    }


def _stored(r: MonthlyReport) -> dict:
    return _out(r.month, r.metrics, r.narrative, r.narrative_source, r.generated_at,
                str(r.generated_by) if r.generated_by else None, final=True)


def _build(db: Session, month: str, user: User, final: bool) -> dict:
    metrics = svc.compute_metrics(db, month)
    narrative, source = svc.write_narrative(metrics)
    now = _now()
    if not final:
        return _out(month, metrics, narrative, source, now, str(user.user_id), final=False)
    report = db.get(MonthlyReport, month) or MonthlyReport(month=month, narrative="", narrative_source="")
    report.metrics, report.narrative, report.narrative_source = metrics, narrative, source
    report.generated_at, report.generated_by = now, user.user_id
    db.add(report)
    db.commit()
    db.refresh(report)
    return _stored(report)


def _final(month: str) -> bool:
    try:
        return svc.check_reportable(month, _now())
    except svc.ReportError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/monthly")
def get_monthly_report(
    month: Optional[str] = Query(default=None, description="YYYY-MM in Malaysia time; defaults to last month"),
    db: Session = Depends(deps.get_db),
    hr: User = Depends(deps.get_current_hr_user),
) -> dict:
    month = month or svc.previous_month(_now())
    final = _final(month)
    if final and (stored := db.get(MonthlyReport, month)):
        return _stored(stored)
    return _build(db, month, hr, final)


@router.post("/monthly/{month}/regenerate")
def regenerate_monthly_report(
    month: str,
    db: Session = Depends(deps.get_db),
    hr: User = Depends(deps.get_current_hr_user),
) -> dict:
    return _build(db, month, hr, _final(month))


@router.get("/monthly/{month}/claims")
def report_claims(
    month: str,
    metric: str,
    category: Optional[str] = None,
    team: Optional[str] = None,
    code: Optional[str] = None,
    db: Session = Depends(deps.get_db),
    hr: User = Depends(deps.get_current_hr_user),
) -> dict:
    """The claims behind one number on the report, computed by the same query as the number."""
    _final(month)
    try:
        rows = svc.claim_rows(db, month, metric, category=category, team=team, code=code)
    except svc.ReportError as e:
        raise HTTPException(status_code=400, detail=str(e))
    amounts = {r.reim_id: r.amount for r in rows}
    claims = [db.get(Reimbursement, r.reim_id) for r in rows]
    claims.sort(key=lambda c: c.created_at, reverse=True)
    ctx = _list_context(db, claims)
    return {
        "month": month,
        "metric": metric,
        "currency": svc.CURRENCY,
        "count": len(rows),
        "total": svc.total(rows),
        # report_amount: what the claim adds to the number (approved, claimed or recovered amount).
        "claims": [{**_build_reimbursement_response(c, db, include_line_items=False, viewer_is_hr=True, prefetched=ctx),
                    "report_amount": amounts[c.reim_id]} for c in claims],
    }
