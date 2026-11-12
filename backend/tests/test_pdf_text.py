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


def _table_pdf(path):
    """A grade table whose hotel cell spans three grade rows, like Appendix 1 of the RECLAIM policy."""
    doc = pymupdf.open()
    page = doc.new_page()
    xs, ys = [72, 192, 312, 432], [100, 130, 160, 190, 220]
    for x in xs:
        page.draw_line((x, ys[0]), (x, ys[-1]))
    for y in ys:
        page.draw_line((xs[0], y), (xs[-1] if y in (ys[0], ys[1], ys[-1]) else xs[2], y))
    page.insert_text((76, 120), "Grade")
    page.insert_text((196, 120), "Daily allowance")
    page.insert_text((316, 120), "Hotel")
    for row, grade in enumerate(("Grade 5", "Grade 6", "Grade 7")):
        page.insert_text((76, 150 + 30 * row), grade)
        page.insert_text((196, 150 + 30 * row), "MYR 90 per day")
    page.insert_text((316, 180), "MYR 375 per day")
    doc.save(path)
    doc.close()


def test_a_cell_spanning_rows_is_repeated_down_its_own_column(tmp_path):
    path = tmp_path / "grades.pdf"
    _table_pdf(path)

    text = pdf_to_markdown(str(path))

    rows = [[cell.strip() for cell in line.strip("|").split("|")]
            for line in text.splitlines() if line.lstrip("| ").startswith("Grade ")]
    assert rows == [[f"Grade {g}", "MYR 90 per day", "MYR 375 per day"] for g in (5, 6, 7)]
