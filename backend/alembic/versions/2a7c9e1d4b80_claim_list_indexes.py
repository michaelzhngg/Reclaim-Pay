"""indexes for the claim list: reimbursements by date and owner, payouts by claim and date

Revision ID: 2a7c9e1d4b80
Revises: 1f551d7ef95b
Create Date: 2026-11-12 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '2a7c9e1d4b80'
down_revision: Union[str, None] = '1f551d7ef95b'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# IF NOT EXISTS: databases bootstrapped with create_all already have the model-declared ones.
INDEXES = (
    ("ix_reimbursements_created_at", "reimbursements", "created_at"),
    ("ix_reimbursements_user_id", "reimbursements", "user_id"),
    ("ix_payouts_reim_id_created_at", "payouts", "reim_id, created_at"),
)


def upgrade() -> None:
    for name, table, columns in INDEXES:
        op.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({columns})")


def downgrade() -> None:
    # ix_reimbursements_user_id stays: the model declares it, so create_all databases had it before this revision.
    op.execute("DROP INDEX IF EXISTS ix_payouts_reim_id_created_at")
    op.execute("DROP INDEX IF EXISTS ix_reimbursements_created_at")
