from core.models import LineItem, SupportingDocument
from tests.test_approvals_api import _claim, env  # noqa: F401


def _doc(db, owner, tmp_path, name="r.jpg", type_="image", write=True, path=None):
    if write:
        folder = tmp_path / str(owner.user_id)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / name).write_bytes(b"receipt-bytes")
    doc = SupportingDocument(user_id=owner.user_id, name=name, type=type_, extracted_data={},
                             path=path or f"/storage/documents/{owner.user_id}/{name}")
    db.add(doc)
    db.commit()
    return doc


def _link(db, claim, doc):
    li = db.query(LineItem).filter(LineItem.reim_id == claim.reim_id).one()
    li.document_id = doc.document_id
    db.add(li)
    db.commit()


def test_hr_sees_and_opens_the_employee_receipt(env, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setattr("api.receipt_files.STORAGE_DOCUMENTS_DIR", tmp_path)
    c, db, users, act_as = env
    claim = _claim(db, users["emp"], "HR_REVIEW")
    doc = _doc(db, users["emp"], tmp_path)
    _link(db, claim, doc)

    act_as("hr1")
    item = c.get(f"/api/v1/reimbursements/{claim.reim_id}").json()["line_items"][0]
    assert item["receipt_url"] == f"/api/v1/documents/{doc.document_id}/file"

    res = c.get(f"/api/v1/documents/{doc.document_id}/file")
    assert res.status_code == 200
    assert res.content == b"receipt-bytes"


def test_pdf_receipts_are_marked_and_missing_files_get_no_link(env, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setattr("api.receipt_files.STORAGE_DOCUMENTS_DIR", tmp_path)
    c, db, users, act_as = env
    pdf_claim = _claim(db, users["emp"], "HR_REVIEW")
    _link(db, pdf_claim, _doc(db, users["emp"], tmp_path, name="r.pdf", type_="pdf"))
    gone_claim = _claim(db, users["emp"], "HR_REVIEW")
    _link(db, gone_claim, _doc(db, users["emp"], tmp_path, name="gone.jpg", write=False))

    act_as("hr1")
    pdf_item = c.get(f"/api/v1/reimbursements/{pdf_claim.reim_id}").json()["line_items"][0]
    assert pdf_item["receipt_url"].endswith("/file?kind=pdf")
    gone_item = c.get(f"/api/v1/reimbursements/{gone_claim.reim_id}").json()["line_items"][0]
    assert gone_item["receipt_url"] is None


def test_employee_cannot_open_someone_elses_receipt(env, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setattr("api.receipt_files.STORAGE_DOCUMENTS_DIR", tmp_path)
    c, db, users, act_as = env
    theirs = _doc(db, users["hr2"], tmp_path)
    mine = _doc(db, users["emp"], tmp_path, name="mine.jpg")

    act_as("emp")
    assert c.get(f"/api/v1/documents/{theirs.document_id}/file").status_code == 403
    assert c.get(f"/api/v1/documents/{mine.document_id}/file").status_code == 200


def test_stored_paths_cannot_escape_the_documents_folder(env, tmp_path, monkeypatch):  # noqa: F811
    root = tmp_path / "documents"
    root.mkdir()
    (tmp_path / "secret.txt").write_text("nope")
    monkeypatch.setattr("api.receipt_files.STORAGE_DOCUMENTS_DIR", root)
    c, db, users, act_as = env
    doc = _doc(db, users["emp"], tmp_path, write=False, path="/storage/documents/../secret.txt")

    act_as("hr1")
    assert c.get(f"/api/v1/documents/{doc.document_id}/file").status_code == 404


def test_path_guard_without_a_database(tmp_path, monkeypatch):
    from api.receipt_files import receipt_file_path, receipt_url

    root = tmp_path / "documents"
    (root / "u1").mkdir(parents=True)
    (root / "u1" / "r.jpg").write_bytes(b"x")
    (tmp_path / "secret.txt").write_text("nope")
    monkeypatch.setattr("api.receipt_files.STORAGE_DOCUMENTS_DIR", root)

    assert receipt_file_path("/storage/documents/u1/r.jpg") == (root / "u1" / "r.jpg").resolve()
    assert receipt_file_path("/storage/documents/u1/missing.jpg") is None
    assert receipt_file_path("/storage/documents/../secret.txt") is None
    assert receipt_file_path("/etc/passwd") is None
    assert receipt_file_path(None) is None
    assert receipt_url("abc") == "/api/v1/documents/abc/file"
    assert receipt_url("abc", is_pdf=True) == "/api/v1/documents/abc/file?kind=pdf"


def test_only_images_and_pdfs_are_served_inline(env, tmp_path, monkeypatch):  # noqa: F811
    monkeypatch.setattr("api.receipt_files.STORAGE_DOCUMENTS_DIR", tmp_path)
    c, db, users, act_as = env
    html = _doc(db, users["emp"], tmp_path, name="evil.html", type_="pdf")
    jpg = _doc(db, users["emp"], tmp_path, name="ok.jpg")

    act_as("hr1")
    res = c.get(f"/api/v1/documents/{html.document_id}/file")
    assert res.headers["content-type"] == "application/octet-stream"
    assert res.headers["content-disposition"].startswith("attachment")
    assert c.get(f"/api/v1/documents/{jpg.document_id}/file").headers["content-type"] == "image/jpeg"


def test_media_type_allowlist_without_a_database():
    from pathlib import Path

    from api.receipt_files import receipt_media_type

    assert receipt_media_type(Path("a.JPG")) == "image/jpeg"
    assert receipt_media_type(Path("a.pdf")) == "application/pdf"
    for bad in ("a.html", "a.svg", "a.htm", "a.xml", "a.js", "noext"):
        assert receipt_media_type(Path(bad)) is None
