"""Verify the 16-slide technical deck against its editable source contract."""

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


DEFAULT_SOURCE_PATH = Path("docs/presentations/2026-07-30-technical-achievements-presentation.md")
DEFAULT_PPTX_PATH = Path("docs/presentations/AI-ChotBot-technical-achievements.pptx")
HAN = re.compile(r"[\u4e00-\u9fff]")
SENSITIVE = re.compile(r"access[_ -]?token|channel[_ -]?secret|analytics_hash_key|database_id", re.I)


def _iter_shapes(shapes):
    for shape in shapes:
        yield shape
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from _iter_shapes(shape.shapes)


def _shape_texts(slide) -> list[str]:
    texts: list[str] = []
    for shape in _iter_shapes(slide.shapes):
        if getattr(shape, "has_table", False):
            texts.extend(cell.text.strip() for row in shape.table.rows for cell in row.cells if cell.text.strip())
        elif getattr(shape, "has_text_frame", False) and shape.text.strip():
            texts.append(shape.text.strip())
    return texts


def _notes_text(slide) -> str:
    return slide.notes_slide.notes_text_frame.text.strip()


def _native_text(shape) -> bool:
    return shape.shape_type != MSO_SHAPE_TYPE.PICTURE and getattr(shape, "has_text_frame", False) and bool(shape.text.strip())


def _named(slide, prefix: str) -> list:
    return [shape for shape in _iter_shapes(slide.shapes) if shape.name.startswith(prefix)]


def _require_exact_text(slide, name: str, expected: str, errors: list[str], slide_number: int, label: str) -> None:
    shapes = _named(slide, name)
    exact = [shape for shape in shapes if shape.name == name]
    if len(shapes) != 1 or len(exact) != 1:
        errors.append(f"Slide {slide_number} requires {name} exactly once (no copy suffix)")
    elif not _native_text(exact[0]):
        errors.append(f"Slide {slide_number} {name} must be a native non-empty text shape")
    elif exact[0].text.strip() != expected:
        errors.append(f"Slide {slide_number} {label} must match the source")


def _require_named_terms(slide, prefix: str, terms: tuple[str, ...], errors: list[str], slide_number: int, expected_count: int | None = None) -> None:
    shapes = _named(slide, prefix)
    expected_count = len(terms) if expected_count is None else expected_count
    if len(shapes) != expected_count or any(not _native_text(shape) for shape in shapes):
        errors.append(f"Slide {slide_number} {prefix} shapes must be native non-empty text shapes exactly once")
        return
    text = "\n".join(shape.text.strip().casefold() for shape in shapes)
    for term in terms:
        if term.casefold() not in text:
            errors.append(f"Slide {slide_number} {prefix} must include {term}")


def _require_named_keyword(slide, name: str, keyword: str, errors: list[str], slide_number: int) -> None:
    shapes = _named(slide, name)
    exact = [shape for shape in shapes if shape.name == name]
    if len(shapes) != 1 or len(exact) != 1:
        errors.append(f"Slide {slide_number} requires {name} exactly once (no copy suffix)")
    elif not _native_text(exact[0]):
        errors.append(f"Slide {slide_number} {name} must be a native non-empty text shape")
    elif keyword.casefold() not in exact[0].text.casefold():
        errors.append(f"Slide {slide_number} {name} must include {keyword}")


def _require_named_line(slide, name: str, errors: list[str]) -> None:
    shapes = _named(slide, name)
    exact = [shape for shape in shapes if shape.name == name]
    if len(shapes) != 1 or len(exact) != 1 or exact[0].shape_type != MSO_SHAPE_TYPE.LINE:
        errors.append(f"Slide 4 requires {name} exactly once as a native LINE connector")


def _validate_source(source_path: Path) -> tuple[list, list[str]]:
    try:
        slides = parse_markdown(source_path)
    except (OSError, ValueError) as error:
        return [], [f"Technical source cannot be parsed: {error}"]
    errors: list[str] = []
    if len(slides) != 16:
        return slides, [f"Technical source must contain 16 slides, found {len(slides)}"]
    if [slide.number for slide in slides] != list(range(1, 17)):
        errors.append("Technical source slide numbers must be 1..16 in order")
    for slide in slides:
        if not slide.title.strip() or not HAN.search(slide.title):
            errors.append(f"Technical source slide {slide.number} needs a Traditional Chinese title")
        if not 3 <= len(slide.bullets) <= 5:
            errors.append(f"Technical source slide {slide.number} must have 3–5 bullet points")
        if any(not bullet.strip() or not HAN.search(bullet) for bullet in slide.bullets):
            errors.append(f"Technical source slide {slide.number} needs Traditional Chinese bullets")
        if not slide.speaker_notes.strip() or not HAN.search(slide.speaker_notes):
            errors.append(f"Technical source slide {slide.number} needs Traditional Chinese speaker notes")
    if len(slides) == 16:
        if "開發中" not in " ".join(slides[12].bullets):
            errors.append("Technical source slide 13 must explicitly state 開發中")
        if "待合併前驗證" not in " ".join(slides[13].bullets):
            errors.append("Technical source slide 14 must state 待合併前驗證")
    return slides, errors


def verify_technical_presentation(pptx_path: Path, source_path: Path) -> list[str]:
    """Return every source, editable-text, and special-page contract violation."""
    source_slides, errors = _validate_source(source_path)
    if not pptx_path.is_file():
        return [*errors, f"Technical PowerPoint does not exist: {pptx_path}"]
    try:
        presentation = Presentation(pptx_path)
    except Exception as error:  # pragma: no cover
        return [*errors, f"Technical PowerPoint cannot be opened: {error}"]
    if len(presentation.slides) != 16:
        return [*errors, f"Technical PowerPoint must contain 16 slides, found {len(presentation.slides)}"]

    for source in source_slides:
        slide = presentation.slides[source.number - 1]
        _require_exact_text(slide, f"title-{source.number}", source.title, errors, source.number, "title")
        _require_exact_text(slide, f"conclusion-{source.number}", source.bullets[0], errors, source.number, "conclusion")
        bullet_shapes = _named(slide, f"bullet-{source.number}-")
        if len(bullet_shapes) != len(source.bullets):
            errors.append(f"Slide {source.number} requires source bullet shapes exactly once")
        for index, bullet in enumerate(source.bullets, start=1):
            _require_exact_text(slide, f"bullet-{source.number}-{index}", bullet, errors, source.number, "bullet")
        notes = _notes_text(slide)
        if source.speaker_notes not in notes:
            errors.append(f"Slide {source.number} speaker notes must contain the source speaker notes")
        sensitive = SENSITIVE.search("\n".join([*_shape_texts(slide), notes]))
        if sensitive:
            errors.append(f"Sensitive identifier found on slide {source.number}: {sensitive.group(0)}")

    if len(source_slides) != 16:
        return errors
    slide = presentation.slides[2]
    _require_named_terms(slide, "architecture-node-", ("架構節點",), errors, 3, 7)
    connectors = _named(slide, "architecture-connector-")
    if len(connectors) < 6 or any(shape.shape_type != MSO_SHAPE_TYPE.LINE for shape in connectors):
        errors.append("Slide 3 needs at least six native architecture connectors")
    _require_named_terms(presentation.slides[3], "message-flow-step-", ("資料流程",), errors, 4, 6)
    for connector in range(1, 6):
        _require_named_line(presentation.slides[3], f"message-flow-connector-{connector}", errors)
    for name, keyword in (("retry", "retry"), ("dlq", "dlq"), ("deduplication", "deduplication")):
        _require_named_keyword(presentation.slides[5], f"reliability-node-{name}", keyword, errors, 6)
    for name, keyword in (("question-record", "問題紀錄"), ("weather-cache", "weather cache"), ("group-settings", "group settings"), ("metrics", "metrics"), ("lifecycle", "lifecycle")):
        _require_named_keyword(presentation.slides[8], f"data-node-{name}", keyword, errors, 9)
    _require_named_terms(presentation.slides[10], "observability-event-", ("可觀測事件",), errors, 11, 5)
    visible_11 = "\n".join(_shape_texts(presentation.slides[10]))
    if "webhookEventId" not in visible_11 or "operationId" not in visible_11:
        errors.append("Slide 11 needs webhookEventId and operationId native text")
    quality = "\n".join(_shape_texts(presentation.slides[11]))
    for pattern, label in ((r"主線\s*134\s*通過", "主線 134 通過"), (r"知識搜尋\s*421\s*通過", "知識搜尋 421 通過"), (r"1 項.*超過\s*5 秒", "1 項超過 5 秒"), (r"設定檢查待更新", "設定檢查待更新")):
        if not re.search(pattern, quality):
            errors.append(f"Slide 12 needs quality-gate evidence: {label}")
    for name in ("r2", "ingestion-queue", "workers-ai", "vectorize", "retrieval", "grounded-answer"):
        _require_named_keyword(presentation.slides[12], f"knowledge-node-{name}", name, errors, 13)
    _require_exact_text(presentation.slides[12], "development-status-13", "開發中", errors, 13, "development-status")
    _require_named_keyword(presentation.slides[13], "maturity-matrix-14", "已完成", errors, 14)
    maturity_text = "\n".join(
        shape.text.strip()
        for shape in _named(presentation.slides[13], "maturity-matrix-14")
        if shape.name == "maturity-matrix-14" and _native_text(shape)
    )
    for state in ("開發中", "待合併前驗證", "待正式環境驗證"):
        if state not in maturity_text:
            errors.append(f"Slide 14 maturity-matrix-14 must include {state}")
    if re.search(r"\b\d+(?:\.\d+)?\s*%", "\n".join(_shape_texts(presentation.slides[13]))):
        errors.append("Slide 14 must not use percentage maturity")
    for step, bullet in enumerate(source_slides[15].bullets, start=1):
        _require_exact_text(presentation.slides[15], f"roadmap-step-{step}", bullet, errors, 16, f"roadmap-step-{step}")
    return errors


def main() -> None:
    errors = verify_technical_presentation(DEFAULT_PPTX_PATH, DEFAULT_SOURCE_PATH)
    if errors:
        print("\n".join(errors))
        raise SystemExit(1)
    print("Technical PowerPoint verification passed: 16 slides")


if __name__ == "__main__":
    main()
