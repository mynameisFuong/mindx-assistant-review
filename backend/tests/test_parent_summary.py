import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app
from parent_summary import ParentSummaryRequest, format_parent_summary, validate_summary_request, SUMMARY_RULES, SUMMARY_SCHEMA
from parent_summary import summary_prompt
from course_policy import course_family, course_homework_rules


class ParentSummaryTests(unittest.TestCase):
    def request(self, **updates):
        payload = dict(lesson_text="Lập trình và kiểm thử dự án game cuối khóa.", session_number="11", study_date="2026-11-01", study_period="chiều", course_name="Lớp thử nghiệm", lesson_title="Nâng cấp sản phẩm cuối khóa")
        return ParentSummaryRequest(**(payload | updates))

    def output(self):
        return dict(title="Tiêu đề AI", lesson_points=["Thực hiện lập trình cho dự án"], remarks=["Nội dung học.", "Nội dung thực hành.", "Kỹ năng được luyện tập."], homework=["Ôn lại kiến thức của buổi học."])

    def test_template_preserves_teacher_date_title_links_and_homework(self):
        url = "https://drive.google.com/file/d/example/view?usp=sharing"
        req = self.request(notebook_url=url, homework="- Hoàn thiện phần di chuyển.\n- Kiểm tra va chạm.")
        text = format_parent_summary(req, self.output())
        for expected in ("BUỔI HỌC THỨ 11, HỌC CHIỀU NGÀY (01/11)", "NÂNG CẤP SẢN PHẨM CUỐI KHÓA", "📌 Nội dung buổi học:", "📌 Nhận xét:", "📌 Dặn dò:", "Trân trọng @All", url, "Hoàn thiện phần di chuyển.", "Kiểm tra va chạm.", "Denise"):
            self.assertIn(expected, text)
        self.assertNotIn("Tiêu đề AI", text)
        self.assertNotIn("Ôn lại kiến thức của buổi học.", text)
        self.assertNotIn("&#", text)

    def test_optional_link_and_denise_are_not_invented(self):
        text = format_parent_summary(self.request(notebook_url="", remind_denise=False, study_period=""), self.output())
        self.assertNotIn("notebook", text)
        self.assertNotIn("Denise", text)
        self.assertIn("HỌC NGÀY (01/11)", text)

    def test_robotics_ignores_old_denise_checkbox_and_ai_homework(self):
        req = self.request(course_name='LVV-ROB-PREA14', remind_denise=True)
        data = self.output() | {'homework': ['Hoàn thành bài tập trên Denise ở nhà.']}
        text = format_parent_summary(req, data)
        self.assertNotIn('Denise', text)
        self.assertNotIn('ở nhà', text)
        self.assertNotIn('Ôn lại kiến thức', text)
        self.assertIn('thực hành tiếp tại lớp', text)

    def test_robotics_allows_no_homework_and_shares_materials_as_reference_only(self):
        req = self.request(course_name='SH-KIND-ROB4A11', notebook_url='https://example.com/slides')
        text = format_parent_summary(req, self.output() | {'homework': []})
        self.assertIn('Tài liệu buổi học để phụ huynh tham khảo: https://example.com/slides', text)
        self.assertNotIn('notebook', text)
        self.assertNotIn('Denise', text)

    def test_robotics_rejects_manual_homework_but_keeps_preparation_notes(self):
        with self.assertRaisesRegex(ValueError, 'ROB không có bài tập'):
            validate_summary_request(self.request(course_name='LVV-ROB-PREA14', homework='Làm bài trên Denise.'))
        req = self.request(course_name='LVV-ROB-PREA14', homework='Đi học đúng giờ ở buổi tiếp theo.')
        validate_summary_request(req)
        self.assertIn(req.homework, format_parent_summary(req, self.output()))

    def test_c4k_always_mentions_denise_once(self):
        req = self.request(course_name='LVV-C4K-PTA18', remind_denise=False)
        text = format_parent_summary(req, self.output())
        self.assertEqual(text.count('Denise'), 1)
        text = format_parent_summary(req, self.output() | {'homework': ['Hoàn thành bài thực hành đã giao trên Denise.']})
        self.assertEqual(text.count('Denise'), 1)

    def test_course_policy_reaches_individual_and_parent_prompts(self):
        for code, family in [('LVV-ROB-PREA14','ROB'), ('SH-KIND-ROB4A11','ROB'), ('Robotics 6+','ROB'), ('LVV-C4K-PTA18','C4K'), ('OTHER-CLASS','')]:
            with self.subTest(code=code):
                self.assertEqual(course_family(code), family)
                individual = app.GenerateRequest(lesson_text='Nội dung học.', course_name=code, students=[])
                self.assertIn(course_homework_rules(code), app.build_prompt(individual, []))
                # JSON encoding preserves Vietnamese and the policy text.
                self.assertIn(course_homework_rules(code), summary_prompt(self.request(course_name=code)))

    def test_validation_rejects_missing_and_unsafe_inputs(self):
        for changes in ({"session_number": "0"}, {"study_date": "2026-02-30"}, {"lesson_text": " "}, {"notebook_url": "javascript:alert(1)"}, {"study_period": "trưa"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_summary_request(self.request(**changes))

    def test_incomplete_model_response_is_rejected(self):
        for field in ("remarks", "lesson_points", "homework"):
            with self.subTest(field=field), self.assertRaises(ValueError):
                format_parent_summary(self.request(), self.output() | {field: []})

    def test_uses_summary_rules_without_changing_individual_generation(self):
        client = type("Client", (), {"close": lambda self: None})()
        with patch.dict(os.environ, {"MXRA_MOCK_GEMINI": "0"}), patch.object(app, "get_client", return_value=client), patch.object(app, "call_gemini_json", return_value=self.output()) as call:
            result = app.generate_parent_summary(self.request())
        self.assertIn("📌 Nhận xét:", result.markdown)
        self.assertIs(call.call_args.args[3], SUMMARY_RULES)
        self.assertIs(call.call_args.args[4], SUMMARY_SCHEMA)
        if app.HAS_GOOGLE_GENAI:
            self.assertEqual(app.generation_config(1).system_instruction, app.SYSTEM_RULES)

    def test_job_api_and_json_header(self):
        if not app.HAS_FASTAPI:
            self.skipTest("FastAPI is not installed")
        from fastapi.testclient import TestClient
        with patch.dict(os.environ, {"MXRA_MOCK_GEMINI": "1"}), TestClient(app.app) as client:
            self.assertEqual(client.post('/summary/jobs', content='{}', headers={'Content-Type': 'text/plain'}).status_code, 415)
            self.assertEqual(client.post('/summary/jobs', json=self.request(study_date='').model_dump()).status_code, 422)
            started = client.post('/summary/jobs', json=self.request().model_dump())
            self.assertEqual(started.status_code, 200)
            import time
            for _ in range(100):
                response = client.get('/generate/jobs/' + started.json()['job_id'])
                self.assertEqual(response.status_code, 200)
                if response.json()['status'] == 'done':
                    self.assertTrue(response.json()['result']['mock_mode'])
                    self.assertIn('BUỔI HỌC THỨ 11', response.json()['result']['markdown'])
                    break
                time.sleep(.01)
            else:
                self.fail('Summary job did not finish')


if __name__ == '__main__':
    unittest.main()
