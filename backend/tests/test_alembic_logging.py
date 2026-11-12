import logging

from alembic import command
from alembic.config import Config

from core.database import _ALEMBIC_INI


def test_running_migrations_leaves_app_and_server_loggers_on():
    # The API runs migrations at startup; their logging setup must not mute loggers that
    # already exist, or uvicorn's access log and every logger.exception go silent.
    app_logger = logging.getLogger("engine.services.probe")
    server_logger = logging.getLogger("uvicorn.error")

    try:
        command.current(Config(_ALEMBIC_INI))  # loads env.py (logging setup), then reads the revision
    except Exception:
        pass  # no database reachable: the logging setup has already run

    assert not app_logger.disabled and not server_logger.disabled
