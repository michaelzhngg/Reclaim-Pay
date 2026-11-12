"""claims: contractor invoice period

Revision ID: b3e5f7a9c1d2
Revises: f4a8d3e5b6c7
Create Date: 2026-11-12 20:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b3e5f7a9c1d2'
down_revision: Union[str, None] = 'f4a8d3e5b6c7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # An invoice is still a Reimbursement row; only its period is new.
    op.add_column('reimbursements', sa.Column('invoice_period_start', sa.Date(), nullable=True))
    op.add_column('reimbursements', sa.Column('invoice_period_end', sa.Date(), nullable=True))


def downgrade() -> None:
    op.drop_column('reimbursements', 'invoice_period_end')
    op.drop_column('reimbursements', 'invoice_period_start')
