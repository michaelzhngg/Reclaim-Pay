"""HR verdicts on Receipt Shield signals (R1a)

Revision ID: 5d3a7b2e9f44
Revises: 3b1e5f0c9d21
Create Date: 2026-11-12 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '5d3a7b2e9f44'
down_revision: Union[str, None] = '3b1e5f0c9d21'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # IF NOT EXISTS: databases bootstrapped with create_all already have the table from the model.
    op.execute("""
        CREATE TABLE IF NOT EXISTS signal_reviews (
            review_id UUID PRIMARY KEY,
            reim_id UUID NOT NULL REFERENCES reimbursements(reim_id) ON DELETE CASCADE,
            signal_code VARCHAR NOT NULL,
            document_key VARCHAR NOT NULL DEFAULT '',
            verdict VARCHAR NOT NULL,
            reviewed_by UUID NOT NULL REFERENCES employees(user_id),
            created_at TIMESTAMP WITH TIME ZONE,
            updated_at TIMESTAMP WITH TIME ZONE,
            CONSTRAINT uq_signal_review UNIQUE (reim_id, signal_code, document_key)
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_signal_reviews_reim_id ON signal_reviews (reim_id)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS signal_reviews")
