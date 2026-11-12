"""Find a receipt's uploaded file on disk, from the path stored on its SupportingDocument."""
from pathlib import Path
from typing import Optional

STORAGE_DOCUMENTS_DIR = Path(__file__).parent.parent / "storage" / "documents"
_STORED_PREFIX = "/storage/documents/"

# Only these are served inline. Anything else (an uploaded .html or .svg, say) would run as
# script on the app's own domain when HR opens it, so it is sent as a download instead.
SAFE_RECEIPT_TYPES = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".pdf": "application/pdf",
}


def receipt_media_type(file_path: Path) -> Optional[str]:
    """The inline media type for a receipt file, or None when it must be downloaded instead."""
    return SAFE_RECEIPT_TYPES.get(file_path.suffix.lower())


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
