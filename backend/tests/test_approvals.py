import pytest
from datetime import datetime, timezone
from engine.services.approvals import register_approval, split_batch

NOW = datetime(2026, 11, 3, tzinfo=timezone.utc)

def test_dual_needs_two_distinct_hr():
    a, done = register_approval([], "hr1", "emp1", NOW, required=2)
    assert done is False and len(a) == 1
    a, done = register_approval(a, "hr1", "emp1", NOW, required=2)
    assert done is False and len(a) == 1
    a, done = register_approval(a, "hr2", "emp1", NOW, required=2)
    assert done is True and {x["hr_id"] for x in a} == {"hr1", "hr2"}

def test_single_approval_completes_when_required_is_one():
    _, done = register_approval([], "hr1", "emp1", NOW, required=1)
    assert done is True

def test_self_approval_rejected():
    with pytest.raises(ValueError, match="SELF_APPROVAL"):
        register_approval([], "hr1", "hr1", NOW, required=1)

def test_batch_only_takes_hr_quick_in_review():
    rows = [{"reim_id": "a", "tier": "HR_QUICK", "status": "REVIEW", "user_id": "e1"},
            {"reim_id": "b", "tier": "HR_REVIEW", "status": "REVIEW", "user_id": "e2"},
            {"reim_id": "c", "tier": "HR_QUICK", "status": "PAID", "user_id": "e3"},
            {"reim_id": "d", "tier": "HR_QUICK", "status": "REVIEW", "user_id": "hr1"}]
    ok, skipped = split_batch(rows, approver_id="hr1")
    assert ok == ["a"]
    assert {s["reim_id"]: s["reason"] for s in skipped} == {"b": "NOT_HR_QUICK", "c": "NOT_IN_REVIEW", "d": "SELF_APPROVAL"}


def test_batch_never_takes_a_vendor_booking():
    rows = [{"reim_id": "b1", "tier": "HR_QUICK", "status": "REVIEW", "user_id": "e1", "kind": "VENDOR_BOOKING"},
            {"reim_id": "c1", "tier": "HR_QUICK", "status": "REVIEW", "user_id": "e1", "kind": "CLAIM"}]
    ok, skipped = split_batch(rows, approver_id="hr1")
    assert ok == ["c1"]
    assert skipped == [{"reim_id": "b1", "reason": "VENDOR_BOOKING"}]
