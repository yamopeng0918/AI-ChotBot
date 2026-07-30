"""Verify the 16-slide technical presentation's source and shape contract."""

from __future__ import annotations

from pathlib import Path
import re
import sys

from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

try:
    from .build_client_powerpoint import parse_markdown
except ImportError:  # Supports direct execution from scripts/presentation.
    from build_client_powerpoint import parse_markdown


DEFAULT_SOURCE_PATH = Path(
    "docs/presentations/2026-07-30-technical-achievements-presentation.md"
)
DEFAULT_PPTX_PATH = Path(
    "docs/presentations/AI-ChotBot-technical-achievements.pptx"
)
HAN_CHARACTER = re.compile(r"[\u4e00-\u9fff]")


def _iter_shapes(shapes):
    for shape in shapes:
        yield shape
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from _iter_shapes(shape.shapes)


def _named_shapes(slide, prefix: str) -> list:
    return [
        shape
        for shape in _iter_shapes(slide.shapes)
        if shape.name.startswith(prefix)
    ]


def _slide_text(slide) -> str:
    return "\n".join(
        shape.text
        for shape in _iter_shapes(slide.shapes)
        if getattr(shape, "has_text_frame", False)
    )


def _has_native_named_shape(slide, name: str) -> bool:
    return any(
        shape.name == name and shape.shape_type != MSO_SHAPE_TYPE.PICTURE
        for shape in _iter_shapes(slide.shapes)
    )


def _validate_source(source_path: Path) -> list[str]:
    errors: list[str] = []
    try:
        slides = parse_markdown(source_path)
    except (OSError, ValueError) as error:
        return [f"Technical source cannot be parsed: {error}"]

    if len(slides) != 16:
        errors.append(f"Technical source must contain 16 slides, found {len(slides)}")
        return errors
    if [slide.number for slide in slides] != list(range(1, 17)):
        errors.append("Technical source slide numbers must be 1..16 in order")
    for slide in slides:
        if not slide.title.strip() or not HAN_CHARACTER.search(slide.title):
            errors.append(f"Technical source slide {slide.number} needs a Traditional Chinese title")
        if not 3 <= len(slide.bullets) <= 5:
            errors.append(
                f"Technical source slide {slide.number} must have 3–5 bullet points"
            )
        if not slide.speaker_notes.strip() or not HAN_CHARACTER.search(
            slide.speaker_notes
        ):
            errors.append(
                f"Technical source slide {slide.number} needs Traditional Chinese speaker notes"
            )
    if "開發中" not in " ".join(slides[12].bullets):
        errors.append("Technical source slide 13 must explicitly state 開發中")
    return errors


def verify_technical_presentation(pptx_path: Path, source_path: Path) -> list[str]:
    """Return contract violations for a technical PowerPoint and its source."""
    errors = _validate_source(source_path)
    if not pptx_path.is_file():
        return [*errors, f"Technical PowerPoint does not exist: {pptx_path}"]

    try:
        presentation = Presentation(pptx_path)
    except Exception as error:  # pragma: no cover - python-pptx owns parser details.
        return [*errors, f"Technical PowerPoint cannot be opened: {error}"]

    if len(presentation.slides) != 16:
        return [
            *errors,
            f"Technical PowerPoint must contain 16 slides, found {len(presentation.slides)}",
        ]

    slide = presentation.slides[2]
    architecture_nodes = _named_shapes(slide, "architecture-node-")
    if len(architecture_nodes) < 7 or any(
        node.shape_type == MSO_SHAPE_TYPE.PICTURE for node in architecture_nodes
    ):
        errors.append("Slide 3 needs at least seven native architecture-node- shapes")
    if not any(
        shape.shape_type == MSO_SHAPE_TYPE.LINE
        for shape in _named_shapes(slide, "architecture-connector-")
    ):
        errors.append("Slide 3 needs a native architecture connector")

    slide = presentation.slides[3]
    message_steps = _named_shapes(slide, "message-flow-step-")
    if len(message_steps) < 6 or any(
        shape.shape_type == MSO_SHAPE_TYPE.PICTURE for shape in message_steps
    ):
        errors.append("Slide 4 needs at least six native message-flow-step- shapes")

    slide = presentation.slides[5]
    for name in ("retry", "dlq", "deduplication"):
        if not _has_native_named_shape(slide, f"reliability-node-{name}"):
            errors.append(f"Slide 6 needs native reliability-node-{name}")

    slide = presentation.slides[8]
    for name in (
        "d1-work-record",
        "weather-cache",
        "group-settings",
        "metrics",
        "30-day-lifecycle",
    ):
        if not _has_native_named_shape(slide, f"data-node-{name}"):
            errors.append(f"Slide 9 needs native data-node-{name}")

    slide = presentation.slides[10]
    observability_text = _slide_text(slide)
    if "webhookEventId" not in observability_text or "operationId" not in observability_text:
        errors.append("Slide 11 needs webhookEventId and operationId")
    if len(_named_shapes(slide, "observability-event-")) < 5:
        errors.append("Slide 11 needs at least five observability events")

    slide = presentation.slides[11]
    quality_text = _slide_text(slide)
    for required_text in ("主線 134", "知識搜尋 421", "1 項逾時", "上線前檢查待更新"):
        if required_text not in quality_text:
            errors.append(f"Slide 12 needs quality-gate evidence: {required_text}")

    slide = presentation.slides[12]
    for name in (
        "r2",
        "ingestion-queue",
        "workers-ai",
        "vectorize",
        "retrieval",
        "grounded-answer",
    ):
        if not _has_native_named_shape(slide, f"knowledge-node-{name}"):
            errors.append(f"Slide 13 needs native knowledge-node-{name}")
    if not _named_shapes(slide, "development-status-"):
        errors.append("Slide 13 needs a development-status- shape")

    slide = presentation.slides[13]
    maturity_shapes = _named_shapes(slide, "maturity-matrix-")
    if len(maturity_shapes) != 1:
        errors.append("Slide 14 needs exactly one named maturity-matrix-")
    if re.search(r"\b\d+(?:\.\d+)?\s*%", _slide_text(slide)):
        errors.append("Slide 14 must not use percentage maturity")

    slide = presentation.slides[15]
    for step in range(1, 6):
        if len(_named_shapes(slide, f"roadmap-step-{step}")) != 1:
            errors.append(f"Slide 16 needs roadmap-step-{step} exactly once")

    return errors


def main() -> None:
    errors = verify_technical_presentation(DEFAULT_PPTX_PATH, DEFAULT_SOURCE_PATH)
    if errors:
        print("\n".join(errors))
        raise SystemExit(1)
    print("Technical PowerPoint verification passed: 16 slides")


if __name__ == "__main__":
    main()
