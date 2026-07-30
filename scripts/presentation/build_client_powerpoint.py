"""Parse the Markdown source used to build the client PowerPoint deck."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
import re


DEFAULT_OUTPUT_PATH = Path(
    "docs/presentations/AI-ChotBot-project-progress-client.pptx"
)
SLIDE_HEADING = re.compile(
    r"^##\s+第\s*(?P<number>\d+)\s*頁\s*[｜|]\s*(?P<title>.+?)\s*$"
)
BULLET = re.compile(r"^\s*(?:[-*+]\s+|\d+\.\s+)(?P<text>.+?)\s*$")
SPEAKER_NOTES = "**講者備註：**"


@dataclass
class TableRow:
    cells: list[str]


@dataclass
class SlideContent:
    number: int
    title: str
    bullets: list[str] = field(default_factory=list)
    table_rows: list[TableRow] = field(default_factory=list)
    mermaid_blocks: list[str] = field(default_factory=list)
    speaker_notes: str = ""


def _table_cells(line: str) -> list[str]:
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def _is_table_separator(cells: list[str]) -> bool:
    return all(re.fullmatch(r":?-{3,}:?", cell) for cell in cells)


def parse_markdown(path: Path) -> list[SlideContent]:
    """Return deck content from the limited Markdown format used by the source."""
    slides: list[SlideContent] = []
    current: SlideContent | None = None
    in_mermaid = False
    mermaid_lines: list[str] = []
    in_table = False
    table_header_seen = False

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        heading = SLIDE_HEADING.match(raw_line)
        if heading:
            if in_mermaid:
                raise ValueError("Unclosed Mermaid block before a slide heading")
            current = SlideContent(
                number=int(heading.group("number")), title=heading.group("title")
            )
            slides.append(current)
            in_table = False
            table_header_seen = False
            continue

        if current is None:
            continue

        if raw_line.strip() == "```mermaid":
            in_mermaid = True
            mermaid_lines = []
            continue
        if in_mermaid:
            if raw_line.strip() == "```":
                current.mermaid_blocks.append("\n".join(mermaid_lines).strip())
                in_mermaid = False
            else:
                mermaid_lines.append(raw_line)
            continue

        if raw_line.startswith(SPEAKER_NOTES):
            current.speaker_notes = raw_line.removeprefix(SPEAKER_NOTES).strip()
            continue

        if raw_line.lstrip().startswith("|") and raw_line.rstrip().endswith("|"):
            cells = _table_cells(raw_line)
            if not in_table:
                in_table = True
                table_header_seen = False
            if not table_header_seen:
                table_header_seen = True
            elif not _is_table_separator(cells):
                current.table_rows.append(TableRow(cells=cells))
            continue

        in_table = False

        bullet = BULLET.match(raw_line)
        if bullet:
            current.bullets.append(bullet.group("text"))

    if in_mermaid:
        raise ValueError("Unclosed Mermaid block at end of Markdown")

    return slides
