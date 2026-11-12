"""policy questions asked before spending (F1)

Revision ID: 4c2f6a1d8e33
Revises: 3b1e5f0c9d21
Create Date: 2026-11-12 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = '4c2f6a1d8e33'
down_revision: Union[str, None] = '3b1e5f0c9d21'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# IF NOT EXISTS: databases bootstrapped with create_all already have the model-declared tables.
# SET NULL: deleting a policy (api/policies.py) removes its sections; the questions stay for HR's counts.
def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS policy_questions (
            question_id UUID PRIMARY KEY,
            user_id UUID NOT NULL REFERENCES employees(user_id),
            policy_id UUID REFERENCES policies(policy_id) ON DELETE SET NULL,
            section_id UUID REFERENCES policy_sections(section_id) ON DELETE SET NULL,
            question TEXT NOT NULL,
            answer TEXT,
            covered BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMP WITH TIME ZONE
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS ix_policy_questions_user_id ON policy_questions (user_id)")
    op.execute("CREATE INDEX IF NOT EXISTS ix_policy_questions_created_at ON policy_questions (created_at)")


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS policy_questions")
