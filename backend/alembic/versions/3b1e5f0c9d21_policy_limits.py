"""policy limits as data: policy_limits and policy_zone_places

Revision ID: 3b1e5f0c9d21
Revises: c8d2e3f4a5b6
Create Date: 2026-11-12 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '3b1e5f0c9d21'
down_revision: Union[str, None] = 'c8d2e3f4a5b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# IF NOT EXISTS: databases bootstrapped with create_all already have the model-declared tables.
def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS policy_limits (
            limit_id UUID PRIMARY KEY,
            policy_id UUID NOT NULL REFERENCES policies(policy_id),
            category VARCHAR NOT NULL,
            kind VARCHAR NOT NULL,
            unit VARCHAR NOT NULL,
            amount NUMERIC(12, 2),
            currency VARCHAR NOT NULL,
            grade_min INTEGER,
            grade_max INTEGER,
            scope VARCHAR NOT NULL,
            zone VARCHAR,
            source_section VARCHAR,
            source_quote TEXT,
            status VARCHAR NOT NULL,
            confirmed_by UUID REFERENCES employees(user_id),
            confirmed_at TIMESTAMP WITH TIME ZONE,
            created_at TIMESTAMP WITH TIME ZONE
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_policy_limits_policy_id ON policy_limits (policy_id)")
    op.execute("""
        CREATE TABLE IF NOT EXISTS policy_zone_places (
            id UUID PRIMARY KEY,
            policy_id UUID NOT NULL REFERENCES policies(policy_id),
            zone VARCHAR NOT NULL,
            place VARCHAR NOT NULL,
            status VARCHAR NOT NULL
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_policy_zone_places_policy_id ON policy_zone_places (policy_id)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS policy_zone_places")
    op.execute("DROP TABLE IF EXISTS policy_limits")
