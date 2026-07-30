"""Contract tests for the technical presentation verifier."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from pptx import Presentation
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.util import Inches

from scripts.presentation.build_client_powerpoint import parse_markdown
from scripts.presentation.build_technical_powerpoint import build_technical_presentation
from scripts.presentation.verify_technical_powerpoint import verify_technical_presentation


ROOT = Path(__file__).resolve().parents[2]
SOURCE_PATH = ROOT / "docs/presentations/2026-07-30-technical-achievements-presentation.md"
ONE_PIXEL_PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\x0dIDAT\x08\xd7c\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d\x00\x00\x00\x00IEND\xaeB`\x82"


class TechnicalSourceTests(unittest.TestCase):
    def test_source_has_sixteen_sequential_traditional_chinese_slides(self) -> None:
        slides = parse_markdown(SOURCE_PATH)
        self.assertEqual(list(range(1, 17)), [slide.number for slide in slides])
        self.assertTrue(all(slide.title.strip() for slide in slides))
        self.assertTrue(all(3 <= len(slide.bullets) <= 5 for slide in slides))
        self.assertTrue(all(slide.speaker_notes.strip() for slide in slides))
        self.assertTrue(all("開發中" in " ".join(slide.bullets) for slide in slides[12:13]))
        self.assertIn("待合併前驗證", " ".join(slides[13].bullets))


class TechnicalVerifierContractTests(unittest.TestCase):
    def _add_text(self, shapes, name: str, text: str) -> None:
        shape = shapes.add_textbox(Inches(0.4), Inches(0.4), Inches(8), Inches(0.35))
        shape.name = name
        shape.text = text

    def _write_deck(
        self, destination: Path, *, title_override: str | None = None,
        bullet_override: str | None = None, conclusion_override: str | None = None,
        notes_override: str | None = None, duplicate_name: str | None = None,
        empty_special: tuple[int, str] | None = None, omit_special: tuple[int, str] | None = None,
        sensitive_location: str | None = None, quality_override: str | None = None,
        maturity_override: str | None = None, roadmap_override: str | None = None,
        rename_special: tuple[int, str, str] | None = None,
        message_connector_replacement: str | None = None,
        duplicate_message_connector: bool = False,
    ) -> None:
        presentation = Presentation()
        presentation.slides._sldIdLst.clear()
        source_slides = parse_markdown(SOURCE_PATH)
        for source in source_slides:
            slide = presentation.slides.add_slide(presentation.slide_layouts[6])
            self._add_text(slide.shapes, f"title-{source.number}", title_override if source.number == 1 and title_override is not None else source.title)
            self._add_text(slide.shapes, f"conclusion-{source.number}", conclusion_override if source.number == 1 and conclusion_override is not None else source.bullets[0])
            for index, bullet in enumerate(source.bullets, start=1):
                text = bullet_override if source.number == 1 and index == 1 and bullet_override is not None else bullet
                self._add_text(slide.shapes, f"bullet-{source.number}-{index}", text)
            slide.notes_slide.notes_text_frame.text = notes_override if source.number == 1 and notes_override is not None else source.speaker_notes

        def special(slide_number: int, name: str, text: str) -> None:
            if omit_special == (slide_number, name):
                return
            output_name = rename_special[2] if rename_special and rename_special[:2] == (slide_number, name) else name
            self._add_text(presentation.slides[slide_number - 1].shapes, output_name, "" if empty_special == (slide_number, name) else text)

        for index in range(7):
            special(3, f"architecture-node-{index + 1}", f"架構節點 {index + 1}")
        for index in range(6):
            connector = presentation.slides[2].shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(1), Inches(1), Inches(2), Inches(1))
            connector.name = f"architecture-connector-{index + 1}"
        for index in range(6):
            special(4, f"message-flow-step-{index + 1}", f"資料流程 {index + 1}")
        for index in range(5):
            name = f"message-flow-connector-{index + 1}"
            if index == 0 and message_connector_replacement == "textbox":
                self._add_text(presentation.slides[3].shapes, name, "假 connector")
            elif index == 0 and message_connector_replacement == "picture":
                shape = presentation.slides[3].shapes.add_picture(BytesIO(ONE_PIXEL_PNG), Inches(1), Inches(1), Inches(1), Inches(.3))
                shape.name = name
            else:
                connector = presentation.slides[3].shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(1), Inches(1), Inches(2), Inches(1))
                connector.name = name
        if duplicate_message_connector:
            connector = presentation.slides[3].shapes.add_connector(MSO_CONNECTOR.STRAIGHT, Inches(1), Inches(1), Inches(2), Inches(1))
            connector.name = "message-flow-connector-1-copy"
        for name in ("retry", "dlq", "deduplication"):
            special(6, f"reliability-node-{name}", name)
        for name, text in (("question-record", "D1 問題紀錄"), ("weather-cache", "weather cache"), ("group-settings", "group settings"), ("metrics", "metrics"), ("lifecycle", "lifecycle")):
            special(9, f"data-node-{name}", text)
        special(11, "observability-correlation-webhook", "webhookEventId")
        special(11, "observability-correlation-operation", "operationId")
        for index in range(5):
            special(11, f"observability-event-{index + 1}", f"可觀測事件 {index + 1}")
        for name, text in (("main", "主線 134 通過"), ("knowledge", "知識搜尋 421 通過"), ("timeout", "1 項超過 5 秒"), ("predeploy", "設定檢查待更新")):
            special(12, f"quality-gate-{name}", quality_override if name == "main" and quality_override is not None else text)
        for name in ("r2", "ingestion-queue", "workers-ai", "vectorize", "retrieval", "grounded-answer"):
            special(13, f"knowledge-node-{name}", name)
        special(13, "development-status-13", "開發中")
        special(14, "maturity-matrix-14", maturity_override or "已完成｜開發中｜待合併前驗證｜待正式環境驗證")
        for index in range(1, 6):
            special(16, f"roadmap-step-{index}", roadmap_override if index == 1 and roadmap_override is not None else source_slides[15].bullets[index - 1])
        if duplicate_name:
            self._add_text(presentation.slides[0].shapes, duplicate_name, "重複名稱")
        if sensitive_location == "top":
            self._add_text(presentation.slides[0].shapes, "sensitive-top", "access_token")
        elif sensitive_location == "group":
            group = presentation.slides[0].shapes.add_group_shape()
            inner = group.shapes.add_group_shape()
            self._add_text(inner.shapes, "sensitive-group", "channel_secret")
        elif sensitive_location == "table":
            group = presentation.slides[0].shapes.add_group_shape()
            table = presentation.slides[0].shapes.add_table(1, 1, Inches(1), Inches(1), Inches(2), Inches(.4))
            table.table.cell(0, 0).text = "database_id"
            group.shapes._spTree.insert_element_before(table._element, "p:extLst")
        elif sensitive_location == "notes":
            presentation.slides[0].notes_slide.notes_text_frame.text = "analytics_hash_key"
        presentation.save(destination)

    def _errors(self, **kwargs) -> str:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "deck.pptx"
            self._write_deck(path, **kwargs)
            return "\n".join(verify_technical_presentation(path, SOURCE_PATH)).lower()

    def test_accepts_exact_source_bound_deck(self) -> None:
        self.assertEqual("", self._errors())

    def test_rejects_title_not_equal_to_source(self) -> None:
        self.assertIn("title", self._errors(title_override="English title"))

    def test_rejects_bullet_not_equal_to_source(self) -> None:
        self.assertIn("bullet", self._errors(bullet_override="English bullet"))

    def test_rejects_conclusion_not_equal_to_first_source_bullet(self) -> None:
        self.assertIn("conclusion", self._errors(conclusion_override="English conclusion"))

    def test_rejects_notes_without_source_speaker_notes(self) -> None:
        self.assertIn("speaker notes", self._errors(notes_override="English notes"))

    def test_rejects_copy_suffix_shape_name(self) -> None:
        self.assertIn("title-1", self._errors(duplicate_name="title-1-copy"))

    def test_rejects_sensitive_top_level_text(self) -> None:
        self.assertIn("sensitive", self._errors(sensitive_location="top"))

    def test_rejects_sensitive_nested_group_text(self) -> None:
        self.assertIn("sensitive", self._errors(sensitive_location="group"))

    def test_rejects_sensitive_table_cell(self) -> None:
        self.assertIn("sensitive", self._errors(sensitive_location="table"))

    def test_rejects_sensitive_speaker_notes(self) -> None:
        self.assertIn("sensitive", self._errors(sensitive_location="notes"))

    def test_rejects_empty_architecture_node(self) -> None:
        self.assertIn("architecture-node", self._errors(empty_special=(3, "architecture-node-1")))

    def test_rejects_renamed_reliability_node(self) -> None:
        self.assertIn("reliability-node-retry", self._errors(rename_special=(6, "reliability-node-retry", "reliability-node-retry-copy")))

    def test_rejects_missing_message_flow_node(self) -> None:
        self.assertIn("message-flow-step", self._errors(omit_special=(4, "message-flow-step-1")))

    def test_rejects_empty_reliability_node(self) -> None:
        self.assertIn("reliability-node", self._errors(empty_special=(6, "reliability-node-retry")))

    def test_rejects_empty_data_node(self) -> None:
        self.assertIn("data-node", self._errors(empty_special=(9, "data-node-metrics")))

    def test_rejects_renamed_data_node(self) -> None:
        self.assertIn("data-node-question-record", self._errors(rename_special=(9, "data-node-question-record", "data-node-question-record-copy")))

    def test_rejects_empty_observability_event(self) -> None:
        self.assertIn("observability-event", self._errors(empty_special=(11, "observability-event-1")))

    def test_rejects_quality_failure_claim(self) -> None:
        self.assertIn("quality-gate", self._errors(quality_override="主線 134 失敗"))

    def test_rejects_missing_development_status_text(self) -> None:
        self.assertIn("development-status", self._errors(empty_special=(13, "development-status-13")))

    def test_rejects_renamed_knowledge_node(self) -> None:
        self.assertIn("knowledge-node-r2", self._errors(rename_special=(13, "knowledge-node-r2", "knowledge-node-r2-copy")))

    def test_rejects_maturity_matrix_missing_required_state(self) -> None:
        self.assertIn("maturity", self._errors(maturity_override="已完成｜開發中｜待驗證"))

    def test_rejects_maturity_matrix_copy_suffix(self) -> None:
        self.assertIn("maturity-matrix-14", self._errors(rename_special=(14, "maturity-matrix-14", "maturity-matrix-14-copy")))

    def test_rejects_percentage_maturity_matrix(self) -> None:
        self.assertIn("percentage", self._errors(maturity_override="已完成 80%｜開發中"))

    def test_rejects_english_roadmap_node(self) -> None:
        self.assertIn("roadmap-step-1", self._errors(roadmap_override="1. English step"))

    def test_rejects_textbox_instead_of_message_flow_connector(self) -> None:
        self.assertIn("message-flow-connector-1", self._errors(message_connector_replacement="textbox"))

    def test_rejects_non_line_message_flow_connector(self) -> None:
        self.assertIn("message-flow-connector-1", self._errors(message_connector_replacement="picture"))

    def test_rejects_message_flow_connector_copy_suffix(self) -> None:
        self.assertIn("message-flow-connector-1", self._errors(duplicate_message_connector=True))


class GeneratedTechnicalPowerPointTests(unittest.TestCase):
    def test_generated_deck_satisfies_the_complete_technical_contract(self) -> None:
        with TemporaryDirectory() as directory:
            output_path = Path(directory) / "technical.pptx"

            build_technical_presentation(SOURCE_PATH, output_path)

            self.assertEqual(
                [], verify_technical_presentation(output_path, SOURCE_PATH)
            )


if __name__ == "__main__":
    unittest.main()
