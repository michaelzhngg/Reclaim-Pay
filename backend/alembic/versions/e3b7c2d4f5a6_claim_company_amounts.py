"""claims: company-currency amount and FX quote snapshot

Revision ID: e3b7c2d4f5a6
Revises: d1f5a0c2b3e4
Create Date: 2026-11-12 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'e3b7c2d4f5a6'
down_revision: Union[str, None] = 'd1f5a0c2b3e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('reimbursements', sa.Column('amount_company', sa.Numeric(precision=12, scale=2), nullable=True))
    op.add_column('reimbursements',
                  sa.Column('approved_company_amount', sa.Numeric(precision=12, scale=2), nullable=True))
    op.add_column('reimbursements',
                  sa.Column('fx_rate_to_company', sa.Numeric(precision=18, scale=8), nullable=True))
    op.add_column('reimbursements', sa.Column('fx_rate_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('reimbursements', sa.Column('fx_source', sa.String(), nullable=True))

    # MYR rows have an identity quote. Foreign rows are left unquoted so the app can flag
    # them instead of pretending the stored amount is company currency.
    op.execute(
        """
        UPDATE reimbursements
        SET amount_company = total_claimed_amount,
            approved_company_amount = total_approved_amount,
            fx_rate_to_company = 1,
            fx_rate_at = COALESCE(created_at, now()),
            fx_source = 'IDENTITY'
        WHERE UPPER(currency) = 'MYR'
        """
    )
    op.execute(
        """
        UPDATE reimbursements
        SET fx_source = 'UNQUOTED'
        WHERE UPPER(currency) <> 'MYR'
        """
    )


def downgrade() -> None:
    op.drop_column('reimbursements', 'fx_source')
    op.drop_column('reimbursements', 'fx_rate_at')
    op.drop_column('reimbursements', 'fx_rate_to_company')
    op.drop_column('reimbursements', 'approved_company_amount')
    op.drop_column('reimbursements', 'amount_company')
