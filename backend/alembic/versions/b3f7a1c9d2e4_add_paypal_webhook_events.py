"""add paypal webhook event ledger

Revision ID: b3f7a1c9d2e4
Revises: 2a7c9e1d4b80
Create Date: 2026-11-12 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'b3f7a1c9d2e4'
down_revision: Union[str, None] = 'b8f4c2d91a70'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'paypal_webhook_events',
        sa.Column('event_id', sa.String(length=255), nullable=False),
        sa.Column('event_type', sa.String(length=128), nullable=False),
        sa.Column('resource_id', sa.String(length=255), nullable=True),
        sa.Column('status', sa.String(), nullable=False),
        sa.Column('error', sa.Text(), nullable=True),
        sa.Column('payload', postgresql.JSONB(astext_type=sa.Text()), nullable=False,
                  server_default=sa.text("'{}'::jsonb")),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('processed_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('event_id'),
    )
    op.create_index('ix_paypal_webhook_events_event_type', 'paypal_webhook_events', ['event_type'])
    op.create_index('ix_paypal_webhook_events_resource_id', 'paypal_webhook_events', ['resource_id'])
    op.create_index('ix_paypal_webhook_events_status', 'paypal_webhook_events', ['status'])
    op.create_index('ix_paypal_webhook_events_status_updated_at', 'paypal_webhook_events',
                    ['status', 'updated_at'])


def downgrade() -> None:
    op.drop_table('paypal_webhook_events')
