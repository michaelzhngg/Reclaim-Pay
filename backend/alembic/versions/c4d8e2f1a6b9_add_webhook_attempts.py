"""add attempts to paypal webhook events

Revision ID: c4d8e2f1a6b9
Revises: b3f7a1c9d2e4
Create Date: 2026-11-12 10:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c4d8e2f1a6b9'
down_revision: Union[str, None] = 'b3f7a1c9d2e4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'paypal_webhook_events',
        sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'),
    )


def downgrade() -> None:
    op.drop_column('paypal_webhook_events', 'attempts')
