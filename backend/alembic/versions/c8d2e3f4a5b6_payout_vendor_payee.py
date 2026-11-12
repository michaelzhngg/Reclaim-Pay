"""payouts: record the vendor payee next to the requesting employee

Revision ID: c8d2e3f4a5b6
Revises: b7c1d2e3f4a5
Create Date: 2026-11-12 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'c8d2e3f4a5b6'
down_revision: Union[str, None] = 'b7c1d2e3f4a5'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('payouts', sa.Column('vendor_id', sa.UUID(), nullable=True))
    op.create_foreign_key('fk_payouts_vendor_id', 'payouts', 'vendors', ['vendor_id'], ['vendor_id'])
    op.create_index('ix_payouts_vendor_id', 'payouts', ['vendor_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_payouts_vendor_id', table_name='payouts')
    op.drop_constraint('fk_payouts_vendor_id', 'payouts', type_='foreignkey')
    op.drop_column('payouts', 'vendor_id')
