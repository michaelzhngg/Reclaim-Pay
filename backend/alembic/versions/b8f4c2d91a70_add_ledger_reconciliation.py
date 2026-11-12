"""add ledger reconciliation runs and differences

Revision ID: b8f4c2d91a70
Revises: 2a7c9e1d4b80
Create Date: 2026-11-12 17:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b8f4c2d91a70'
down_revision: Union[str, None] = '2a7c9e1d4b80'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'reconciliation_runs',
        sa.Column('run_id', sa.Uuid(), nullable=False),
        sa.Column('trigger', sa.String(), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('days', sa.Integer(), nullable=False),
        sa.Column('window_start', sa.DateTime(timezone=True), nullable=False),
        sa.Column('window_end', sa.DateTime(timezone=True), nullable=False),
        sa.Column('state', sa.String(), nullable=False),
        sa.Column('reconciled', sa.Integer(), nullable=False),
        sa.Column('total', sa.Integer(), nullable=False),
        sa.Column('pending', sa.Integer(), nullable=False),
        sa.Column('differences_new', sa.Integer(), nullable=False),
        sa.Column('differences_open', sa.Integer(), nullable=False),
        sa.Column('data_through', sa.DateTime(timezone=True), nullable=True),
        sa.Column('mock', sa.Boolean(), nullable=False),
        sa.Column('message', sa.Text(), nullable=True),
        sa.Column('error', sa.String(), nullable=True),
        sa.Column('triggered_by', sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(['triggered_by'], ['employees.user_id']),
        sa.PrimaryKeyConstraint('run_id'),
    )
    op.create_index('ix_reconciliation_runs_started_at', 'reconciliation_runs', ['started_at'])

    op.create_table(
        'reconciliation_differences',
        sa.Column('difference_id', sa.Uuid(), nullable=False),
        sa.Column('kind', sa.String(), nullable=False),
        sa.Column('payout_id', sa.Uuid(), nullable=True),
        sa.Column('reim_id', sa.Uuid(), nullable=True),
        sa.Column('transaction_id', sa.String(), nullable=True),
        sa.Column('amount', sa.Numeric(precision=12, scale=2), nullable=False),
        sa.Column('currency', sa.String(length=3), nullable=False),
        sa.Column('employee_name', sa.String(), nullable=True),
        sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('first_seen_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('first_run_id', sa.Uuid(), nullable=True),
        sa.Column('last_run_id', sa.Uuid(), nullable=True),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('resolution', sa.String(), nullable=True),
        sa.Column('resolved_by', sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(['first_run_id'], ['reconciliation_runs.run_id']),
        sa.ForeignKeyConstraint(['last_run_id'], ['reconciliation_runs.run_id']),
        sa.ForeignKeyConstraint(['payout_id'], ['payouts.payout_id']),
        sa.ForeignKeyConstraint(['reim_id'], ['reimbursements.reim_id']),
        sa.ForeignKeyConstraint(['resolved_by'], ['employees.user_id']),
        sa.PrimaryKeyConstraint('difference_id'),
    )
    op.create_index('ix_reconciliation_differences_payout_id', 'reconciliation_differences', ['payout_id'])
    op.create_index('ix_reconciliation_differences_reim_id', 'reconciliation_differences', ['reim_id'])
    op.create_index('ix_reconciliation_differences_transaction_id', 'reconciliation_differences', ['transaction_id'])
    op.create_index('ix_reconciliation_differences_open', 'reconciliation_differences', ['resolved_at', 'kind'])
    op.create_index(
        'uq_reconciliation_differences_open_payout',
        'reconciliation_differences',
        ['payout_id'],
        unique=True,
        postgresql_where=sa.text("resolved_at IS NULL AND payout_id IS NOT NULL"),
    )
    op.create_index(
        'uq_reconciliation_differences_open_transaction',
        'reconciliation_differences',
        ['transaction_id'],
        unique=True,
        postgresql_where=sa.text("resolved_at IS NULL AND transaction_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index('uq_reconciliation_differences_open_transaction', table_name='reconciliation_differences')
    op.drop_index('uq_reconciliation_differences_open_payout', table_name='reconciliation_differences')
    op.drop_index('ix_reconciliation_differences_open', table_name='reconciliation_differences')
    op.drop_index('ix_reconciliation_differences_transaction_id', table_name='reconciliation_differences')
    op.drop_index('ix_reconciliation_differences_reim_id', table_name='reconciliation_differences')
    op.drop_index('ix_reconciliation_differences_payout_id', table_name='reconciliation_differences')
    op.drop_table('reconciliation_differences')
    op.drop_index('ix_reconciliation_runs_started_at', table_name='reconciliation_runs')
    op.drop_table('reconciliation_runs')
