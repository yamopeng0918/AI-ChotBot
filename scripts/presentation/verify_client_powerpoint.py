"""Validate a generated client PowerPoint against its Markdown source."""

from __future__ import annotations

from pathlib import Path
import re

from pptx import Presentation

from .build_client_powerpoint import parse_markdown


SENSITIVE_IDENTIFIER = re.compile(
    r"access[_ -]?token|channel[_ -]?secret|analytics_hash_key|database_id",
    re.IGNORECASE,
)
ORDERED_STEP = re.compile(r"^\s*\d+[.)]", re.MULTILINE)


def _shape_texts(slide) -> list[str]:
    texts: list[str] = []
    for shape in slide.shapes:
        if getattr(shape, "has_table", False):
            texts.extend(
                cell.text.strip()
                for row in shape.table.rows
                for cell in row.cells
                if cell.text.strip()
            )
        elif getattr(shape, "has_text_frame", False) and shape.text.strip():
            texts.append(shape.text.strip())
    return texts


def _notes_text(slide) -> str:
    return slide.notes_slide.notes_text_frame.text.strip()


def _shape_is_outside_slide(shape, slide_width: int, slide_height: int) -> bool:
    return (
        shape.left < 0
        or shape.top < 0
        or shape.left + shape.width > slide_width
        or shape.top + shape.height > slide_height
    )


def verify_presentation(pptx_path: Path, source_path: Path) -> list[str]:
    """Return contract violations for ``pptx_path``; an empty list means success."""
    presentation = Presentation(pptx_path)
    source_slides = parse_markdown(source_path)
    errors: list[str] = []

    if len(presentation.slides) != 14:
        errors.append(f"Expected 14 slides, found {len(presentation.slides)}")
    if abs(presentation.slide_width * 9 - presentation.slide_height * 16) > 10:
        errors.append("Presentation aspect ratio must be 16:9")

    for index, source_slide in enumerate(source_slides):
        if index >= len(presentation.slides):
            break
        slide = presentation.slides[index]
        slide_number = index + 1
        texts = _shape_texts(slide)
        body_texts = [text for text in texts if text != source_slide.title]
        notes = _notes_text(slide)

        if source_slide.title not in texts:
            errors.append(f"Slide {slide_number} title does not match the source")
        if not notes:
            errors.append(f"Slide {slide_number} speaker notes are empty")

        for shape in slide.shapes:
            if _shape_is_outside_slide(
                shape, presentation.slide_width, presentation.slide_height
            ):
                errors.append(f"Slide {slide_number} has a shape outside slide bounds")

        sensitive_match = SENSITIVE_IDENTIFIER.search("\n".join([*texts, notes]))
        if sensitive_match:
            errors.append(
                f"Sensitive identifier found on slide {slide_number}: "
                f"{sensitive_match.group(0)}"
            )

        if slide_number == 5 and len(body_texts) < 6:
            errors.append("Slide 5 must contain at least six flow nodes")
        if slide_number == 9:
            technologies = [row.cells[0] for row in source_slide.table_rows]
            if any(technology not in texts for technology in technologies):
                errors.append("Slide 9 must contain all 13 technical names")
        if slide_number == 14 and len(ORDERED_STEP.findall("\n".join(body_texts))) < 5:
            errors.append("Slide 14 must contain five ordered steps")

    return errors
