"""Source and structural-contract tests for the technical presentation."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from pptx import Presentation
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.util import Inches

from scripts.presentation.build_client_powerpoint import parse_markdown
from scripts.presentation.verify_technical_powerpoint import (
    verify_technical_presentation,
)


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SOURCE_PATH = (
    REPOSITORY_ROOT
    / "docs"
    / "presentations"
    / "2026-07-30-technical-achievements-presentation.md"
)


class TechnicalSourceTests(unittest.TestCase):
    def test_source_has_sixteen_sequential_traditional_chinese_slides(self) -> None:
        slides = parse_markdown(SOURCE_PATH)

        self.assertEqual(16, len(slides))
        self.assertEqual(list(range(1, 17)), [slide.number for slide in slides])
        self.assertTrue(all(slide.title.strip() for slide in slides))
        self.assertTrue(all(any("\u4e00" <= char <= "\u9fff" for char in slide.title) for slide in slides))

    def test_source_gives_each_slide_three_to_five_points_and_notes(self) -> None:
        slides = parse_markdown(SOURCE_PATH)

        self.assertTrue(all(3 <= len(slide.bullets) <= 5 for slide in slides))
        self.assertTrue(all(slide.speaker_notes.strip() for slide in slides))
        self.assertTrue(
            all(
                any("\u4e00" <= char <= "\u9fff" for char in slide.speaker_notes)
                for slide in slides
            )
        )

    def test_knowledge_search_slide_is_explicitly_in_development(self) -> None:
        slides = parse_markdown(SOURCE_PATH)

        self.assertIn("開發中", " ".join(slides[12].bullets))


class TechnicalVerifierContractTests(unittest.TestCase):
    def _write_contract_deck(
        self, destination: Path, *, include_architecture_connector: bool = True
    ) -> None:
        presentation = Presentation()
        presentation.slides._sldIdLst.clear()

        for _ in range(16):
            presentation.slides.add_slide(presentation.slide_layouts[6])

        def add_text(slide_number: int, name: str, text: str) -> None:
            shape = presentation.slides[slide_number - 1].shapes.add_textbox(
                Inches(0.5), Inches(0.5), Inches(3), Inches(0.4)
            )
            shape.name = name
            shape.text = text

        for index in range(7):
            shape = presentation.slides[2].shapes.add_shape(
                MSO_SHAPE.ROUNDED_RECTANGLE,
                Inches(0.5 + index), Inches(1), Inches(0.7), Inches(0.4)
            )
            shape.name = f"architecture-node-{index + 1}"
            shape.text = f"節點 {index + 1}"
        if include_architecture_connector:
            connector = presentation.slides[2].shapes.add_connector(
                MSO_CONNECTOR.STRAIGHT,
                Inches(1), Inches(2), Inches(2), Inches(2)
            )
            connector.name = "architecture-connector-1"

        for index in range(6):
            add_text(4, f"message-flow-step-{index + 1}", f"流程 {index + 1}")

        for name in ("retry", "dlq", "deduplication"):
            add_text(6, f"reliability-node-{name}", name)

        for name in (
            "d1-work-record",
            "weather-cache",
            "group-settings",
            "metrics",
            "30-day-lifecycle",
        ):
            add_text(9, f"data-node-{name}", name)

        add_text(11, "observability-correlation-webhook", "webhookEventId")
        add_text(11, "observability-correlation-operation", "operationId")
        for index in range(5):
            add_text(11, f"observability-event-{index + 1}", f"事件 {index + 1}")

        add_text(12, "quality-gate-main", "主線 134")
        add_text(12, "quality-gate-knowledge", "知識搜尋 421")
        add_text(12, "quality-gate-timeout", "1 項逾時")
        add_text(12, "quality-gate-predeploy", "上線前檢查待更新")

        for name in (
            "r2",
            "ingestion-queue",
            "workers-ai",
            "vectorize",
            "retrieval",
            "grounded-answer",
        ):
            add_text(13, f"knowledge-node-{name}", name.replace("-", " "))
        add_text(13, "development-status-13", "開發中")

        add_text(14, "maturity-matrix-14", "已完成／開發中／待驗證")

        for index in range(1, 6):
            add_text(16, f"roadmap-step-{index}", f"路線圖 {index}")

        presentation.save(destination)

    def test_accepts_a_deck_with_all_required_technical_contract_shapes(self) -> None:
        with TemporaryDirectory() as directory:
            pptx_path = Path(directory) / "technical.pptx"
            self._write_contract_deck(pptx_path)

            self.assertEqual(
                [], verify_technical_presentation(pptx_path, SOURCE_PATH)
            )

    def test_rejects_an_architecture_page_without_a_native_connector(self) -> None:
        with TemporaryDirectory() as directory:
            pptx_path = Path(directory) / "technical.pptx"
            self._write_contract_deck(
                pptx_path, include_architecture_connector=False
            )

            errors = verify_technical_presentation(pptx_path, SOURCE_PATH)

        self.assertTrue(any("architecture connector" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
