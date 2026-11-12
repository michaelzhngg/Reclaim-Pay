"""contractor contracts, contract categories and company payout settings

Revision ID: d1f5a0c2b3e4
Revises: 5b8d3f0a9c21
Create Date: 2026-11-12 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = 'd1f5a0c2b3e4'
down_revision: Union[str, None] = '5b8d3f0a9c21'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'contractor_contracts',
        sa.Column('contract_id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('country_code', sa.String(length=2), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('rate_amount', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column('rate_unit', sa.String(), nullable=False),
        sa.Column('service_category', sa.String(), nullable=False),
        sa.Column('policy_id', sa.UUID(), nullable=True),
        sa.Column('max_company_amount_per_claim', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('effective_from', sa.Date(), nullable=False),
        sa.Column('effective_to', sa.Date(), nullable=True),
        sa.Column('created_by', sa.UUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['employees.user_id']),
        sa.ForeignKeyConstraint(['policy_id'], ['policies.policy_id']),
        sa.ForeignKeyConstraint(['created_by'], ['employees.user_id']),
        sa.PrimaryKeyConstraint('contract_id'),
    )
    op.create_index(
        'ix_contractor_contracts_user_id', 'contractor_contracts', ['user_id'], unique=True
    )

    op.create_table(
        'contractor_contract_categories',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('contract_id', sa.UUID(), nullable=False),
        sa.Column('category', sa.String(), nullable=False),
        sa.ForeignKeyConstraint(['contract_id'], ['contractor_contracts.contract_id']),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('contract_id', 'category', name='uq_contract_category'),
    )
    op.create_index(
        'ix_contractor_contract_categories_contract_id',
        'contractor_contract_categories',
        ['contract_id'],
        unique=False,
    )

    op.create_table(
        'payout_settings',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('paypal_account_country', sa.String(length=2), server_default='MY', nullable=False),
        sa.Column(
            'held_currencies',
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[\"MYR\"]'::jsonb"),
            nullable=False,
        ),
        sa.Column('updated_by', sa.UUID(), nullable=True),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['updated_by'], ['employees.user_id']),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    op.drop_table('payout_settings')
    op.drop_index('ix_contractor_contract_categories_contract_id',
                  table_name='contractor_contract_categories')
    op.drop_table('contractor_contract_categories')
    op.drop_index('ix_contractor_contracts_user_id', table_name='contractor_contracts')
    op.drop_table('contractor_contracts')
