"""demo employee on grade 6, so policy answers have a grade the uploaded policy lists

Revision ID: a6d2f1c3b8e4
Revises: 4c2f6a1d8e33
Create Date: 2026-11-12 22:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = 'a6d2f1c3b8e4'
down_revision: Union[str, None] = '4c2f6a1d8e33'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Only the seeded demo account, and only while it still has the seed's grade 1.
def upgrade() -> None:
    op.execute("UPDATE employees SET rank = 6 WHERE email = 'employee@example.com' AND rank = 1")


def downgrade() -> None:
    op.execute("UPDATE employees SET rank = 1 WHERE email = 'employee@example.com' AND rank = 6")
