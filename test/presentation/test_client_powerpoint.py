"""Contract tests for the client presentation parser and verifier."""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from pptx import Presentation
from pptx.util import Inches

from scripts.presentation.build_client_powerpoint import parse_markdown
from scripts.presentation.verify_client_powerpoint import verify_presentation


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SOURCE_PATH = (
    REPOSITORY_ROOT
    / "docs"
    / "presentations"
    / "2026-07-30-project-progress-client-presentation.md"
)


class MarkdownParserTests(unittest.TestCase):
    def test_parses_all_fourteen_numbered_slides_with_titles_and_notes(self) -> None:
        slides = parse_markdown(SOURCE_PATH)

        self.assertEqual(14, len(slides))
        self.assertEqual(list(range(1, 15)), [slide.number for slide in slides])
        self.assertTrue(all(slide.title.strip() for slide in slides))
        self.assertTrue(all(slide.speaker_notes.strip() for slide in slides))

    def test_parses_the_thirteen_technical_table_rows_on_slide_nine(self) -> None:
        slides = parse_markdown(SOURCE_PATH)

        self.assertEqual(13, len(slides[8].table_rows))
        self.assertTrue(all(row.cells for row in slides[8].table_rows))

    def test_preserves_bullets_and_mermaid_blocks_without_markdown_engine(self) -> None:
        slides = parse_markdown(SOURCE_PATH)

        self.assertGreaterEqual(len(slides[4].bullets), 4)
        self.assertEqual(1, len(slides[4].mermaid_blocks))
        self.assertIn("flowchart", slides[4].mermaid_blocks[0])


class PresentationVerifierTests(unittest.TestCase):
    def _write_presentation(
        self,
        destination: Path,
        *,
        aspect_ratio: str = "wide",
        title_override: str | None = None,
        include_notes: bool = True,
        flow_node_count: int = 6,
        technology_count: int = 13,
        step_count: int = 5,
        include_sensitive_text: bool = False,
        include_out_of_bounds_shape: bool = False,
    ) -> None:
        source_slides = parse_markdown(SOURCE_PATH)
        presentation = Presentation()
        if aspect_ratio == "wide":
            presentation.slide_width = 13_333_333
            presentation.slide_height = 7_500_000

        for source_slide in source_slides:
            slide = presentation.slides.add_slide(presentation.slide_layouts[6])
            title = title_override if source_slide.number == 1 and title_override else source_slide.title
            slide.shapes.add_textbox(Inches(0.4), Inches(0.2), Inches(12), Inches(0.5)).text_frame.text = title
            if include_notes or source_slide.number != 2:
                slide.notes_slide.notes_text_frame.text = "Speaker guidance"
            if source_slide.number == 5:
                for node in range(flow_node_count):
                    slide.shapes.add_textbox(
                        Inches(0.5 + node), Inches(1.5), Inches(0.8), Inches(0.4)
                    ).text_frame.text = f"Node {node + 1}"
            if source_slide.number == 9:
                table = slide.shapes.add_table(
                    technology_count, 1, Inches(0.5), Inches(1), Inches(5), Inches(4)
                ).table
                for row_index, row in enumerate(source_slide.table_rows[:technology_count]):
                    table.cell(row_index, 0).text = row.cells[0]
            if source_slide.number == 14:
                for step in range(step_count):
                    slide.shapes.add_textbox(
                        Inches(0.5), Inches(1 + step * 0.5), Inches(5), Inches(0.3)
                    ).text_frame.text = f"{step + 1}. Step"

        first_slide = presentation.slides[0]
        if include_sensitive_text:
            first_slide.shapes.add_textbox(
                Inches(0.5), Inches(2), Inches(2), Inches(0.3)
            ).text_frame.text = "access_token"
        if include_out_of_bounds_shape:
            first_slide.shapes.add_textbox(
                Inches(13), Inches(1), Inches(1), Inches(0.3)
            ).text_frame.text = "Overflow"
        presentation.save(destination)

    def test_accepts_a_complete_widescreen_presentation(self) -> None:
        with TemporaryDirectory() as directory:
            pptx_path = Path(directory) / "valid.pptx"
            self._write_presentation(pptx_path)

            self.assertEqual([], verify_presentation(pptx_path, SOURCE_PATH))

    def test_reports_all_required_contract_violations(self) -> None:
        with TemporaryDirectory() as directory:
            pptx_path = Path(directory) / "invalid.pptx"
            self._write_presentation(
                pptx_path,
                aspect_ratio="standard",
                title_override="Unexpected title",
                include_notes=False,
                flow_node_count=5,
                technology_count=12,
                step_count=4,
                include_sensitive_text=True,
                include_out_of_bounds_shape=True,
            )

            errors = "\n".join(verify_presentation(pptx_path, SOURCE_PATH)).lower()

        for expected in (
            "16:9",
            "title",
            "speaker notes",
            "slide 5",
            "slide 9",
            "slide 14",
            "outside",
            "sensitive",
        ):
            self.assertIn(expected, errors)


if __name__ == "__main__":
    unittest.main()
