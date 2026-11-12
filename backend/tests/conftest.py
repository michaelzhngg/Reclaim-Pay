import os

import pytest

os.environ.setdefault("SECRET_KEY", "test-secret-not-default")
os.environ.setdefault("PAYPAL_MOCK_MODE", "true")
# Forced, not defaulted: a key in a local .env must never let a test send real email.
os.environ["RESEND_API_KEY"] = ""


@pytest.fixture
def pg_db():
    """Session on a migrated Postgres named by TEST_DATABASE_URL; every test is rolled back.

    Never point this at the dev database. Tests that use it are skipped when the variable is unset.
    """
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL not set")
    from sqlalchemy import create_engine
    from sqlmodel import Session

    engine = create_engine(url)
    conn = engine.connect()
    outer = conn.begin()
    # Code under test calls commit(); savepoints keep those commits inside the outer transaction.
    session = Session(bind=conn, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        session.close()
        outer.rollback()
        conn.close()
        engine.dispose()
