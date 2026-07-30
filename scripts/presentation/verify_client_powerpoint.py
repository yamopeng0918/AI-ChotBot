"""Validate a generated client PowerPoint against its Markdown source."""

from __future__ import annotations

from pathlib import Path
import re

from pptx import Presentation
from pptx.enum.dml import MSO_COLOR_TYPE, MSO_FILL_TYPE
from pptx.enum.shapes import MSO_SHAPE_TYPE, PP_PLACEHOLDER

try:
    from .build_client_powerpoint import parse_markdown
except ImportError:  # Direct execution: python scripts/presentation/verify_*.py
    from build_client_powerpoint import parse_markdown


SENSITIVE_IDENTIFIER = re.compile(
    r"access[_ -]?token|channel[_ -]?secret|analytics_hash_key|database_id",
    re.IGNORECASE,
)
EXPECTED_BACKGROUND = "081A2E"
EXPECTED_PRIMARY_TEXT = "F4F8FC"
EXPECTED_ACCENT = "21D4B4"
EXPECTED_FONT = "Microsoft JhengHei"
DECORATIVE_TEXT_PREFIXES = (
    "date-",
    "footer-",
    "page-number-",
    "slide-number-",
)


def _iter_shapes(shapes):
    for shape in shapes:
        yield shape
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from _iter_shapes(shape.shapes)


def _shape_texts(slide) -> list[str]:
    texts: list[str] = []
    for shape in _iter_shapes(slide.shapes):
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


def _named_shapes(slide, prefix: str) -> list:
    normalized_prefix = prefix.casefold()
    return [
        shape
        for shape in _iter_shapes(slide.shapes)
        if shape.name.casefold().startswith(normalized_prefix)
    ]


def _is_native_text_shape(shape) -> bool:
    return (
        shape.shape_type != MSO_SHAPE_TYPE.PICTURE
        and getattr(shape, "has_text_frame", False)
        and bool(shape.text.strip())
    )


def _normalized_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.casefold()).strip("-")


def _notes_text(slide) -> str:
    return slide.notes_slide.notes_text_frame.text.strip()


def _shape_is_outside_slide(shape, slide_width: int, slide_height: int) -> bool:
    return (
        shape.left < 0
        or shape.top < 0
        or shape.left + shape.width > slide_width
        or shape.top + shape.height > slide_height
    )


def _rgb_value(color_format) -> str | None:
    try:
        if color_format.type == MSO_COLOR_TYPE.RGB:
            return str(color_format.rgb).upper()
    except (AttributeError, TypeError, ValueError):
        pass
    return None


def _slide_background_rgb(slide) -> str | None:
    fill = slide.background.fill
    if fill.type != MSO_FILL_TYPE.SOLID:
        return None
    return _rgb_value(fill.fore_color)


def _shape_runs(shape):
    if getattr(shape, "has_table", False):
        for row in shape.table.rows:
            for cell in row.cells:
                for paragraph in cell.text_frame.paragraphs:
                    yield from paragraph.runs
    elif getattr(shape, "has_text_frame", False):
        for paragraph in shape.text_frame.paragraphs:
            yield from paragraph.runs


def _is_decorative_text_shape(shape) -> bool:
    if shape.name.casefold().startswith(DECORATIVE_TEXT_PREFIXES):
        return True
    if not getattr(shape, "is_placeholder", False):
        return False
    return shape.placeholder_format.type in {
        PP_PLACEHOLDER.DATE,
        PP_PLACEHOLDER.FOOTER,
        PP_PLACEHOLDER.SLIDE_NUMBER,
    }


def _primary_text_style_counts(presentation) -> tuple[int, int, int]:
    total_weight = 0
    white_weight = 0
    expected_font_weight = 0
    for slide in presentation.slides:
        for shape in _iter_shapes(slide.shapes):
            if _is_decorative_text_shape(shape):
                continue
            for run in _shape_runs(shape):
                weight = len(run.text.strip())
                if not weight:
                    continue
                total_weight += weight
                if _rgb_value(run.font.color) == EXPECTED_PRIMARY_TEXT:
                    white_weight += weight
                if (run.font.name or "").casefold() == EXPECTED_FONT.casefold():
                    expected_font_weight += weight
    return total_weight, white_weight, expected_font_weight


def _has_expected_accent(
    slide, slide_width: int, slide_height: int
) -> bool:
    for shape in _iter_shapes(slide.shapes):
        if (
            shape.width <= 0
            or shape.height <= 0
            or shape.left >= slide_width
            or shape.top >= slide_height
            or shape.left + shape.width <= 0
            or shape.top + shape.height <= 0
        ):
            continue
        try:
            if (
                shape.fill.type == MSO_FILL_TYPE.SOLID
                and _rgb_value(shape.fill.fore_color) == EXPECTED_ACCENT
            ):
                return True
        except (AttributeError, TypeError, ValueError):
            pass
        try:
            if _rgb_value(shape.line.color) == EXPECTED_ACCENT:
                return True
        except (AttributeError, TypeError, ValueError):
            pass
        for run in _shape_runs(shape):
            if _rgb_value(run.font.color) == EXPECTED_ACCENT:
                return True
    return False


def _validate_editable_named_shapes(
    slide,
    prefix: str,
    expected_count: int,
    slide_number: int,
) -> tuple[list, list[str]]:
    shapes = _named_shapes(slide, prefix)
    errors: list[str] = []
    if len(shapes) != expected_count:
        errors.append(
            f"Slide {slide_number} must contain exactly {expected_count} "
            f"{prefix} shapes"
        )
    if any(not _is_native_text_shape(shape) for shape in shapes):
        errors.append(
            f"Slide {slide_number} {prefix} items must be native text shapes"
        )
    return shapes, errors


def verify_presentation(pptx_path: Path, source_path: Path) -> list[str]:
    """Return contract violations for ``pptx_path``; an empty list means success."""
    presentation = Presentation(pptx_path)
    source_slides = parse_markdown(source_path)
    errors: list[str] = []

    if len(presentation.slides) != 14:
        errors.append(f"Expected 14 slides, found {len(presentation.slides)}")
    if abs(presentation.slide_width * 9 - presentation.slide_height * 16) > 10:
        errors.append("Presentation aspect ratio must be 16:9")

    total_text, white_text, expected_font_text = _primary_text_style_counts(
        presentation
    )
    if not total_text or white_text / total_text < 0.75:
        errors.append(
            "At least 75% of primary text must be white (F4F8FC)"
        )
    if not total_text or expected_font_text / total_text < 0.75:
        errors.append(
            f"At least 75% of primary text must use {EXPECTED_FONT}"
        )

    for index, source_slide in enumerate(source_slides):
        if index >= len(presentation.slides):
            break
        slide = presentation.slides[index]
        slide_number = index + 1
        texts = _shape_texts(slide)
        notes = _notes_text(slide)

        if _slide_background_rgb(slide) != EXPECTED_BACKGROUND:
            errors.append(
                f"Slide {slide_number} background must be {EXPECTED_BACKGROUND}"
            )
        if not _has_expected_accent(
            slide, presentation.slide_width, presentation.slide_height
        ):
            errors.append(
                f"Slide {slide_number} must include a visible "
                f"{EXPECTED_ACCENT} teal accent"
            )
        if source_slide.title not in texts:
            errors.append(f"Slide {slide_number} title does not match the source")
        if not notes:
            errors.append(f"Slide {slide_number} speaker notes are empty")
        elif source_slide.speaker_notes not in notes:
            errors.append(
                f"Slide {slide_number} notes must contain the source speaker notes"
            )

        conclusions = _named_shapes(slide, "conclusion-")
        if len(conclusions) != 1 or not _is_native_text_shape(conclusions[0]):
            errors.append(
                f"Slide {slide_number} must contain exactly one native "
                "conclusion- text shape"
            )
        elif conclusions[0].text.strip() != source_slide.bullets[0]:
            errors.append(
                f"Slide {slide_number} conclusion must equal the source conclusion"
            )
        bullets = _named_shapes(slide, "bullet-")
        if not 3 <= len(bullets) <= 5:
            errors.append(
                f"Slide {slide_number} must contain 3–5 bullet- shapes"
            )
        if any(not _is_native_text_shape(shape) for shape in bullets):
            errors.append(
                f"Slide {slide_number} bullet- items must be native text shapes"
            )
        elif [shape.text.strip() for shape in bullets] != source_slide.bullets:
            errors.append(
                f"Slide {slide_number} bullet text and order must match "
                "the source bullets"
            )

        for shape in _iter_shapes(slide.shapes):
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

        if slide_number == 5:
            flow_nodes = _named_shapes(slide, "flow-node-")
            if len(flow_nodes) < 6:
                errors.append(
                    "Slide 5 must contain at least 6 flow-node- shapes"
                )
            if any(not _is_native_text_shape(shape) for shape in flow_nodes):
                errors.append(
                    "Slide 5 flow-node- items must be native text shapes"
                )
            expected_flow_labels = re.findall(
                r"\b[A-F]\[([^\]]+)\]",
                source_slide.mermaid_blocks[0],
            )
            if [
                shape.text.strip()
                for shape in flow_nodes
                if _is_native_text_shape(shape)
            ] != expected_flow_labels:
                errors.append(
                    "Slide 5 flow-node text must match every source flow node"
                )
        if slide_number == 9:
            tech_cards, tech_errors = _validate_editable_named_shapes(
                slide, "tech-card-", 13, slide_number
            )
            errors.extend(tech_errors)
            technologies = [row.cells[0] for row in source_slide.table_rows]
            unmatched_technologies = []
            for technology in technologies:
                normalized_shape_name = f"tech-card-{_normalized_name(technology)}"
                if not any(
                    shape.name.casefold() == normalized_shape_name
                    or technology.casefold() in shape.text.casefold()
                    for shape in tech_cards
                    if _is_native_text_shape(shape)
                ):
                    unmatched_technologies.append(technology)
            if unmatched_technologies:
                errors.append(
                    "Slide 9 must contain every source technical name; "
                    f"missing: {', '.join(unmatched_technologies)}"
                )
        if slide_number == 14:
            roadmap_shapes = _named_shapes(slide, "roadmap-step-")
            expected_names = [
                f"roadmap-step-{number}" for number in range(1, 6)
            ]
            for expected_name in expected_names:
                matches = [
                    shape
                    for shape in roadmap_shapes
                    if shape.name.casefold() == expected_name
                ]
                if len(matches) != 1:
                    errors.append(
                        f"Slide 14 must contain {expected_name} exactly once"
                    )
                elif not _is_native_text_shape(matches[0]):
                    errors.append(
                        f"Slide 14 {expected_name} must be a native text shape"
                    )
                elif re.sub(
                    r"^\d+\.\s*", "", matches[0].text.strip()
                ) != re.sub(
                    r"^\d+\.\s*",
                    "",
                    source_slide.bullets[int(expected_name.rsplit("-", 1)[1]) - 1],
                ):
                    errors.append(
                        f"Slide 14 {expected_name} must match the source roadmap"
                    )
            if len(roadmap_shapes) != 5:
                errors.append(
                    "Slide 14 must contain exactly five roadmap-step- shapes"
                )

    return errors


def main() -> None:
    pptx_path = Path(
        "docs/presentations/AI-ChotBot-project-progress-client.pptx"
    )
    source_path = Path(
        "docs/presentations/2026-07-30-project-progress-client-presentation.md"
    )
    errors = verify_presentation(pptx_path, source_path)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        raise SystemExit(1)
    print("PowerPoint verification passed: 14 slides")


if __name__ == "__main__":
    main()
