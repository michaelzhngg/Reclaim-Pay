"""claims: link a contractor claim to its contract

Revision ID: f4a8d3e5b6c7
Revises: e3b7c2d4f5a6
Create Date: 2026-11-12 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'f4a8d3e5b6c7'
down_revision: Union[str, None] = 'e3b7c2d4f5a6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('reimbursements', sa.Column('contract_id', sa.UUID(), nullable=True))
    op.create_foreign_key(
        'fk_reimbursements_contract_id', 'reimbursements', 'contractor_contracts',
        ['contract_id'], ['contract_id'],
    )
    op.create_index('ix_reimbursements_contract_id', 'reimbursements', ['contract_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_reimbursements_contract_id', table_name='reimbursements')
    op.drop_constraint('fk_reimbursements_contract_id', 'reimbursements', type_='foreignkey')
    op.drop_column('reimbursements', 'contract_id')
