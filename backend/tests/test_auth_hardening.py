import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from engine.risk.types import AutonomyConfig


def test_creating_an_account_needs_an_hr_login():
    from main import app

    client = TestClient(app)
    body = {"email": "attacker@example.com", "name": "A", "role": "HR"}
    assert client.post("/api/v1/employee/", json=body).status_code == 401
    # The old open-looking route is gone, not just guarded.
    assert client.post("/api/v1/auth/register", json={**body, "password": "x"}).status_code in (404, 405)


@pytest.mark.parametrize(
    "bad",
    [
        {"auto_limit_standard": -1},
        {"auto_limit_new": float("inf")},
        {"agent_daily_budget": -0.01},
        {"quick_min_score": 60, "review_min_score": 50},
        {"dual_min_score": 101},
        {"recovery_rate": 1.5},
        {"audit_sample_rate": -0.1},
        {"breaker_window": -1},
    ],
)
def test_config_rejects_out_of_range_values(bad):
    with pytest.raises(ValidationError):
        AutonomyConfig(**bad)


def test_default_config_is_valid():
    AutonomyConfig()
