"""claims: payout currency snapshot and payee country

Revision ID: a7c1e9d4b2f6
Revises: b3e5f7a9c1d2
Create Date: 2026-11-12 20:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'a7c1e9d4b2f6'
down_revision: Union[str, None] = 'b3e5f7a9c1d2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # What HR approved: the amount and currency PayPal receives, and the rate behind it.
    op.add_column('reimbursements',
                  sa.Column('payout_amount', sa.Numeric(precision=12, scale=2), nullable=True))
    op.add_column('reimbursements', sa.Column('payout_currency', sa.String(length=3), nullable=True))
    op.add_column('reimbursements',
                  sa.Column('payout_fx_rate', sa.Numeric(precision=18, scale=8), nullable=True))
    op.add_column('reimbursements', sa.Column('payout_fx_at', sa.DateTime(timezone=True), nullable=True))

    # The guard needs a payee country for every staff member and vendor. Everyone on record
    # predates the guard, so MY is the honest default rather than a guess.
    op.add_column('employees',
                  sa.Column('country_code', sa.String(length=2), server_default='MY', nullable=False))
    op.add_column('vendors',
                  sa.Column('country_code', sa.String(length=2), server_default='MY', nullable=False))


def downgrade() -> None:
    op.drop_column('vendors', 'country_code')
    op.drop_column('employees', 'country_code')
    op.drop_column('reimbursements', 'payout_fx_at')
    op.drop_column('reimbursements', 'payout_fx_rate')
    op.drop_column('reimbursements', 'payout_currency')
    op.drop_column('reimbursements', 'payout_amount')
