"""PDF to markdown for policies and PDF receipts, sized for a 512 MB instance."""
import re

import pymupdf4llm

# The layout model adds ~245 MB per conversion and keeps it, which runs the API out of memory.
pymupdf4llm.use_layout(False)

# Some exported PDFs (Google Docs) put zero-width characters where the spaces should be.
_ZERO_WIDTH = re.compile(r"[​‌‍⁠﻿]+")
_SPACE_RUN = re.compile(r"[ \t]{2,}")
_BLANK_RUN = re.compile(r"\n{3,}")


def clean_markdown(text: str) -> str:
    text = _ZERO_WIDTH.sub(" ", text)
    text = _SPACE_RUN.sub(" ", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    return _BLANK_RUN.sub("\n\n", text).strip()


def pdf_to_markdown(path: str) -> str:
    return clean_markdown(pymupdf4llm.to_markdown(path))
