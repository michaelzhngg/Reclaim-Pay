"""password_tokens for invite and reset links, employees.password_changed_at

Revision ID: 5b8d3f0a9c21
Revises: 2a7c9e1d4b80
Create Date: 2026-11-12 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = '5b8d3f0a9c21'
down_revision: Union[str, None] = '2a7c9e1d4b80'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('employees', sa.Column('password_changed_at', sa.DateTime(timezone=True), nullable=True))
    op.create_table(
        'password_tokens',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('purpose', sa.String(length=16), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['employees.user_id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('token_hash'),
    )
    op.create_index(op.f('ix_password_tokens_user_id'), 'password_tokens', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_password_tokens_user_id'), table_name='password_tokens')
    op.drop_table('password_tokens')
    op.drop_column('employees', 'password_changed_at')
