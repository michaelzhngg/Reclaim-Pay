"""monthly reports for finance (F12)

Revision ID: 7e1b3c5d9a20
Revises: 4c2f6a1d8e33
Create Date: 2026-11-12 20:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '7e1b3c5d9a20'
down_revision: Union[str, None] = '4c2f6a1d8e33'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# IF NOT EXISTS: databases bootstrapped with create_all already have the model-declared tables.
def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS monthly_reports (
            month VARCHAR(7) PRIMARY KEY,
            metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
            narrative TEXT NOT NULL,
            narrative_source VARCHAR NOT NULL,
            generated_at TIMESTAMP WITH TIME ZONE NOT NULL,
            generated_by UUID REFERENCES employees(user_id)
        )
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS monthly_reports")
