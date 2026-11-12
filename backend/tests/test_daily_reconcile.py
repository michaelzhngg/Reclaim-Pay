"""The daily reconciliation entry point: the recorded run and the cron exit codes."""
from contextlib import nullcontext
from types import SimpleNamespace

import pytest
from sqlmodel import select

from core.models import ReconciliationRun
from engine.services.reconcile_history import RecordedRun
from jobs import daily_reconcile as job


def recorded(state="ok", mock=True):
    run = SimpleNamespace(
        state=state, reconciled=2, total=3, pending=0, differences_new=0,
        differences_open=0, mock=mock,
    )
    return RecordedRun(run=run, new_differences=[])


def test_run_once_records_a_run(pg_db):
    result = job.run_once(pg_db, days=1)

    assert result.run.state in ("ok", "no_data")
    stored = pg_db.exec(select(ReconciliationRun)).one()
    assert stored.run_id == result.run.run_id
    assert stored.trigger == "schedule"


def test_main_returns_zero_and_passes_the_window(monkeypatch, capsys):
    seen = {}

    def fake_run(db, days, trigger):
        seen.update(days=days, trigger=trigger)
        return recorded()

    monkeypatch.setattr(job, "Session", lambda engine: nullcontext(object()))
    monkeypatch.setattr(job, "run_and_record", fake_run)

    assert job.main(["--days", "2"]) == 0
    assert seen == {"days": 2, "trigger": "schedule"}
    assert "[RECONCILE] ok: reconciled 2 of 3" in capsys.readouterr().out


def test_main_returns_one_when_the_job_fails(monkeypatch):
    def boom(db, days, trigger):
        raise RuntimeError("database gone")

    monkeypatch.setattr(job, "Session", lambda engine: nullcontext(object()))
    monkeypatch.setattr(job, "run_and_record", boom)

    assert job.main([]) == 1


@pytest.mark.parametrize("days", ["0", "31"])
def test_main_rejects_a_window_outside_paypals_range(days):
    with pytest.raises(SystemExit):
        job.main(["--days", days])


def test_run_once_uses_the_schedule_trigger(monkeypatch):
    seen = {}

    def fake_run(db, days, trigger):
        seen.update(days=days, trigger=trigger)
        return recorded()

    monkeypatch.setattr(job, "run_and_record", fake_run)
    job.run_once(object(), 3)
    assert seen == {"days": 3, "trigger": "schedule"}
