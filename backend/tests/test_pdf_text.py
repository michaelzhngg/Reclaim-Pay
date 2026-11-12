import pymupdf
import pymupdf4llm

from engine.tools.pdf_text import clean_markdown, pdf_to_markdown


def test_zero_width_characters_become_spaces():
    raw = "​maximum​​amount​​MYR​​90.00,-​ per day"
    assert clean_markdown(raw) == "maximum amount MYR 90.00,- per day"


def test_space_runs_and_blank_lines_collapse():
    raw = "  a.  To  provide  clear  rules  \n\n\n\n\n b. Second item \n"
    assert clean_markdown(raw) == "a. To provide clear rules\n\nb. Second item"


def test_markdown_tables_survive_cleaning():
    table = "| Grade | Limit |\n|---|---|\n| 7 | MYR 90.00 |"
    assert clean_markdown(table) == table


def test_layout_model_is_off():
    assert pymupdf4llm._use_layout is False


def test_reads_text_from_a_pdf(tmp_path):
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Intercity transport up to MYR 90.00 per day for grade 7 and below.")
    path = tmp_path / "policy.pdf"
    doc.save(path)
    doc.close()

    text = pdf_to_markdown(str(path))

    assert "MYR 90.00 per day" in text
    assert "​" not in text
