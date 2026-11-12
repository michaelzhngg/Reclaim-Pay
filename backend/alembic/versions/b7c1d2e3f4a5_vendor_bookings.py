"""vendor bookings: vendors, booking details and the claim kind discriminator

Revision ID: b7c1d2e3f4a5
Revises: 2a7c9e1d4b80
Create Date: 2026-11-12 14:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'b7c1d2e3f4a5'
down_revision: Union[str, None] = '2a7c9e1d4b80'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'vendors',
        sa.Column('vendor_id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(), nullable=False),
        sa.Column('name_key', sa.String(), nullable=False),
        sa.Column('default_category', sa.String(), nullable=True),
        sa.Column('paypal_email', sa.String(), nullable=True),
        sa.Column('paypal_payer_id', sa.String(), nullable=True),
        sa.Column('paypal_verified', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('paypal_linked_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('payout_destination_changed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('created_by', sa.UUID(), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['created_by'], ['employees.user_id']),
        sa.PrimaryKeyConstraint('vendor_id'),
    )
    op.create_index('ix_vendors_name_key', 'vendors', ['name_key'], unique=True)
    op.create_index('ix_vendors_paypal_payer_id', 'vendors', ['paypal_payer_id'], unique=False)

    op.create_table(
        'vendor_bookings',
        sa.Column('booking_id', sa.UUID(), nullable=False),
        sa.Column('reim_id', sa.UUID(), nullable=False),
        sa.Column('vendor_id', sa.UUID(), nullable=False),
        sa.Column('service_start', sa.Date(), nullable=False),
        sa.Column('service_end', sa.Date(), nullable=False),
        sa.Column('purpose', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['reim_id'], ['reimbursements.reim_id']),
        sa.ForeignKeyConstraint(['vendor_id'], ['vendors.vendor_id']),
        sa.PrimaryKeyConstraint('booking_id'),
    )
    op.create_index('ix_vendor_bookings_reim_id', 'vendor_bookings', ['reim_id'], unique=True)
    op.create_index('ix_vendor_bookings_vendor_id', 'vendor_bookings', ['vendor_id'], unique=False)

    op.add_column('reimbursements', sa.Column('kind', sa.String(), server_default='CLAIM', nullable=False))
    op.create_index('ix_reimbursements_kind', 'reimbursements', ['kind'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_reimbursements_kind', table_name='reimbursements')
    op.drop_column('reimbursements', 'kind')
    op.drop_index('ix_vendor_bookings_vendor_id', table_name='vendor_bookings')
    op.drop_index('ix_vendor_bookings_reim_id', table_name='vendor_bookings')
    op.drop_table('vendor_bookings')
    op.drop_index('ix_vendors_paypal_payer_id', table_name='vendors')
    op.drop_index('ix_vendors_name_key', table_name='vendors')
    op.drop_table('vendors')
