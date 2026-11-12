"""PDF to markdown for policies and PDF receipts, sized for a 512 MB instance."""
import html
import re

import pymupdf4llm
from pymupdf import table as _table

# The layout model adds ~245 MB per conversion and keeps it, which runs the API out of memory.
pymupdf4llm.use_layout(False)

# Some exported PDFs (Google Docs) put zero-width characters where the spaces should be.
_ZERO_WIDTH = re.compile(r"[​‌‍⁠﻿]+")
_SPACE_RUN = re.compile(r"[ \t]{2,}")
_BLANK_RUN = re.compile(r"\n{3,}")


def _fill_spans(table, cells: list[list]) -> None:
    """Give each empty grid slot the text of the merged cell that covers it.

    PyMuPDF copies from the left before it copies from above, so a cell spanning grade rows
    took its left neighbour's text (Appendix 1 showed grade 6 hotels as "MYR 90 per day")."""
    xs = sorted({c[0] for c in table.cells})
    ys = sorted({c[1] for c in table.cells})
    origins = {(c[1], c[0]): c for c in table.cells}
    texts = {}
    for j, row in enumerate(cells):
        for i, text in enumerate(row):
            if text is not None:
                texts[(ys[j], xs[i])] = text
    for j, row in enumerate(cells):
        for i, text in enumerate(row):
            if text is None:
                for (y0, x0), box in origins.items():
                    if x0 <= xs[i] < box[2] and y0 <= ys[j] < box[3] and (y0, x0) in texts:
                        row[i] = texts[(y0, x0)]
                        break


def _table_markdown(self, clean=False, fill_empty=True):
    cells = [[None if box is None else _table.extract_cells(self.textpage, box, markdown=True)
              for box in row.cells] for row in self.rows]
    if fill_empty:
        _fill_spans(self, cells)
    def text(cell):
        cell = "" if cell is None else cell
        return html.escape(cell.replace("-", "&#45;")) if clean else cell

    names = [text(name or f"Col{i + 1}").replace("\n", "<br>") for i, name in enumerate(self.header.names)]
    lines = ["|" + "|".join(names) + "|", "|" + "|".join("---" for _ in range(self.col_count)) + "|"]
    for row in cells[0 if self.header.external else 1:]:
        lines.append("|" + "|".join(text(cell) for cell in row) + "|")
    return "\n".join(lines) + "\n\n"


_table.Table.to_markdown = _table_markdown


def clean_markdown(text: str) -> str:
    text = _ZERO_WIDTH.sub(" ", text)
    text = _SPACE_RUN.sub(" ", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    return _BLANK_RUN.sub("\n\n", text).strip()


def pdf_to_markdown(path: str) -> str:
    return clean_markdown(pymupdf4llm.to_markdown(path))
