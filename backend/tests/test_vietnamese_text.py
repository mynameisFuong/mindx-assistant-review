from pathlib import Path
import sys
import unicodedata
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
from vietnamese_text import has_unaccented_vietnamese, ensure_vietnamese_json, VietnameseTextError, REPAIR_RULES


class VietnameseTextTests(unittest.TestCase):
    def test_detects_unaccented_education_phrases(self):
        for text in ("Thao luan lap rap mo hinh theo mau duoi su huong dan cua giao vien", "Su dung the lenh da hoc de lap trinh mo hinh hoat dong", "Trong buoi hoc nay, cac con da duoc tham gia thao luan."):
            with self.subTest(text=text):
                self.assertTrue(has_unaccented_vietnamese(text))

    def test_preserves_accented_text_english_names_and_urls(self):
        for text in ("Các con thảo luận lắp ráp mô hình theo mẫu.", "Con ngoan.", "Python, Scratch, Game Maker", "https://example.com/noi dung", "https://example.com/thuc_hanh?x=1", "`lap rap` là tên biến trong ví dụ."):
            with self.subTest(text=text):
                self.assertFalse(has_unaccented_vietnamese(text))

    def test_normalizes_unicode_without_an_extra_model_call(self):
        repair = Mock()
        data = {"comment": unicodedata.normalize('NFD', "Các con thực hành lập trình.")}
        fixed = ensure_vietnamese_json(data, repair)
        self.assertEqual(fixed['comment'], "Các con thực hành lập trình.")
        repair.assert_not_called()

    def test_accented_heading_does_not_hide_unaccented_body(self):
        data = {"comments": [{"id": 3, "comment": "**Điểm mạnh:** Con tap trung lap rap mo hinh."}]}
        fixed = {"comments": [{"id": 3, "comment": "**Điểm mạnh:** Con tập trung lắp ráp mô hình."}]}
        repair = Mock(return_value=fixed)
        self.assertEqual(ensure_vietnamese_json(data, repair), fixed)
        repair.assert_called_once()

    def test_repairs_summary_fields_and_preserves_structure(self):
        data = {"title": "Thuc hanh", "lesson_points": ["Lap rap mo hinh"], "remarks": ["Cac con su dung the lenh."], "homework": ["On lai bai hoc."]}
        fixed = {"title": "Thực hành", "lesson_points": ["Lắp ráp mô hình"], "remarks": ["Các con sử dụng thẻ lệnh."], "homework": ["Ôn lại bài học."]}
        self.assertEqual(ensure_vietnamese_json(data, lambda _: fixed), fixed)

    def test_repair_cannot_change_ids(self):
        data = {"comments": [{"id": 1, "comment": "Con thuc hanh 2 bai. https://example.com/x?id=1"}]}
        fixed = {"comments": [{"id": 2, "comment": "Con thực hành 2 bài. https://example.com/x?id=1"}]}
        with self.assertRaises(VietnameseTextError):
            ensure_vietnamese_json(data, lambda _: fixed)

    def test_only_accents_are_merged_when_model_rewrites_words_numbers_urls_or_punctuation(self):
        data = {"comments": [{"id": 1, "comment": "Con thuc hanh 2 bai. https://example.com/x?id=1"}]}
        expected = {"comments": [{"id": 1, "comment": "Con thực hành 2 bài. https://example.com/x?id=1"}]}
        for fixed in (
            {"comments": [{"id": 1, "comment": "Con thực hành 3 bài. https://example.com/x?id=1"}]},
            {"comments": [{"id": 1, "comment": "Con thực hành 2 bài. https://example.com/x?id=2"}]},
            {"comments": [{"id": 1, "comment": "Con thực hành tốt 2 bài. https://example.com/x?id=1"}]},
            {"comments": [{"id": 1, "comment": "Con thực hành 2 bài! https://example.com/x?id=1"}]},
        ):
            with self.subTest(fixed=fixed):
                self.assertEqual(ensure_vietnamese_json(data, lambda _: fixed), expected)

    def test_still_unaccented_output_is_rejected_after_one_repair(self):
        data = {"comment": "Con lap rap mo hinh."}
        repair = Mock(return_value=data)
        with self.assertRaises(VietnameseTextError):
            ensure_vietnamese_json(data, repair)
        repair.assert_called_once()

    def test_gemini_pipeline_repairs_with_the_same_schema(self):
        before = {"comments": [{"id": 1, "comment": "Con lap rap mo hinh."}]}
        after = {"comments": [{"id": 1, "comment": "Con lắp ráp mô hình."}]}
        with patch.object(app, 'configured_models', return_value=['test-model']), patch.object(app, '_request_gemini_json', side_effect=[before, after]) as request:
            self.assertEqual(app.call_gemini_json({}, 'Nội dung bài học', 1), after)
            self.assertEqual(request.call_count, 2)
            self.assertIs(request.call_args.args[4], REPAIR_RULES)
            self.assertIs(request.call_args.args[5], app.RESPONSE_SCHEMA)

    def test_gemini_pipeline_does_not_return_known_unaccented_text(self):
        data = {"comments": [{"id": 1, "comment": "Con lap rap mo hinh."}]}
        with patch.object(app, 'configured_models', return_value=['test-model']), patch.object(app, '_request_gemini_json', return_value=data) as request:
            with self.assertRaises(app.HTTPException) as raised:
                app.call_gemini_json({}, 'Nội dung bài học', 1)
            self.assertEqual(raised.exception.status_code, 502)
            self.assertIn('thiếu dấu', raised.exception.detail)
            self.assertEqual(request.call_count, 2)


if __name__ == '__main__':
    unittest.main()
