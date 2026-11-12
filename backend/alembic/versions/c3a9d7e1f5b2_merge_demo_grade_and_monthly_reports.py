"""merge the demo employee grade and monthly reports migrations

Both revise 4c2f6a1d8e33, which left two heads and made `alembic upgrade head` fail.
This revision joins them. It changes no schema.

Revision ID: c3a9d7e1f5b2
Revises: a6d2f1c3b8e4, 7e1b3c5d9a20
Create Date: 2026-11-12 22:30:00.000000

"""
from typing import Sequence, Union


# revision identifiers, used by Alembic.
revision: str = 'c3a9d7e1f5b2'
down_revision: Union[str, Sequence[str], None] = ('a6d2f1c3b8e4', '7e1b3c5d9a20')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
