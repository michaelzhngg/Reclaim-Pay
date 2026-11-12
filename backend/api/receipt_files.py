"""Find a receipt's uploaded file on disk, from the path stored on its SupportingDocument."""
from pathlib import Path
from typing import Optional

STORAGE_DOCUMENTS_DIR = Path(__file__).parent.parent / "storage" / "documents"
_STORED_PREFIX = "/storage/documents/"


def receipt_file_path(stored_path: Optional[str]) -> Optional[Path]:
    """The file for a stored path like "/storage/documents/<user>/<name>", or None if it isn't on disk.

    Paths that resolve outside the documents folder are refused.
    """
    if not stored_path or not stored_path.startswith(_STORED_PREFIX):
        return None
    root = STORAGE_DOCUMENTS_DIR.resolve()
    candidate = (root / stored_path[len(_STORED_PREFIX):]).resolve()
    if not candidate.is_relative_to(root) or not candidate.is_file():
        return None
    return candidate


def receipt_url(document_id, is_pdf: bool = False) -> str:
    """The frontend route that streams a receipt's file to a signed-in viewer.

    PDFs carry "?kind=pdf" so the HR page opens them in a tab instead of the image viewer.
    """
    url = f"/api/v1/documents/{document_id}/file"
    return f"{url}?kind=pdf" if is_pdf else url
