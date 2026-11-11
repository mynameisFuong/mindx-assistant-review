from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import time
from threading import Lock
from typing import Any, List
import urllib.error
import urllib.request
from uuid import uuid4
from parent_summary import (
    ParentSummaryRequest, ParentSummaryResponse, SUMMARY_RULES, SUMMARY_SCHEMA,
    validate_summary_request, summary_prompt, format_parent_summary,
)
from vietnamese_text import ensure_vietnamese_json, repair_prompt, REPAIR_RULES, VietnameseTextError
from course_policy import course_family, course_homework_rules

ENV_PATH = Path(__file__).resolve().with_name(".env")


def load_env_file(env_path: Path = ENV_PATH, override: bool = False) -> None:
    try:
        from dotenv import load_dotenv as _load_dotenv

        _load_dotenv(env_path, override=override)
        return
    except ModuleNotFoundError:
        pass

    if not env_path.is_file():
        return

    for raw_line in env_path.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if key and (override or key not in os.environ):
            os.environ[key] = value


load_env_file()

try:
    from fastapi import Depends, FastAPI, Header, HTTPException
    HAS_FASTAPI = True
except ModuleNotFoundError:
    HAS_FASTAPI = False

    class HTTPException(Exception):
        def __init__(self, status_code: int, detail: str):
            super().__init__(detail)
            self.status_code = int(status_code)
            self.detail = str(detail)

    class FastAPI:
        def __init__(self, title: str = "", version: str = ""):
            self.title = title
            self.version = version

        def add_middleware(self, *_args: Any, **_kwargs: Any) -> None:
            return None

        def get(self, _path: str, **_kwargs: Any):
            def decorator(fn):
                return fn
            return decorator

        def post(self, _path: str, **_kwargs: Any):
            def decorator(fn):
                return fn
            return decorator

try:
    from pydantic import BaseModel, Field
    HAS_PYDANTIC = True
except ModuleNotFoundError:
    HAS_PYDANTIC = False

try:
    from google import genai
    from google.genai import types
    HAS_GOOGLE_GENAI = True
except ModuleNotFoundError:
    genai = None  # type: ignore[assignment]
    types = None  # type: ignore[assignment]
    HAS_GOOGLE_GENAI = False

app = FastAPI(title="MindX Review Assistant API", version="0.3.0-gemini")

# Keep the default on a generally available Gemini Developer API model. The
# app may still override this via GEMINI_MODEL in backend/.env.
DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite"
FALLBACK_GEMINI_MODELS = [DEFAULT_GEMINI_MODEL, "gemini-3.8-flash"]
DEFAULT_BATCH_SIZE = 8
MAX_RETRIES_PER_MODEL = 2


if HAS_PYDANTIC:
    class StudentInput(BaseModel):
        id: int
        attendance: str = "Có mặt"
        level: str = "Tốt"
        tags: List[str] = Field(default_factory=list)
        note: str = ""
        checkpoint_ability: int | None = None
        checkpoint_practice: float | None = None
        checkpoint_quiz_correct: int | None = None


    class GenerateRequest(BaseModel):
        lesson_text: str
        course_name: str = ""
        session_label: str = ""
        students: List[StudentInput]


    class GeneratedComment(BaseModel):
        id: int
        comment: str


    class GenerateResponse(BaseModel):
        comments: List[GeneratedComment]
        mock_mode: bool = False
else:
    class StudentInput:
        def __init__(
            self,
            id: int,
            attendance: str = "Có mặt",
            level: str = "Tốt",
            tags: List[str] | None = None,
            note: str = "",
            checkpoint_ability: int | None = None,
            checkpoint_practice: float | None = None,
            checkpoint_quiz_correct: int | None = None,
        ):
            self.id = int(id)
            self.attendance = str(attendance or "Có mặt")
            self.level = str(level or "Tốt")
            self.tags = [str(t) for t in (tags or [])]
            self.note = str(note or "")
            self.checkpoint_ability = int(checkpoint_ability) if checkpoint_ability is not None else None
            self.checkpoint_practice = float(checkpoint_practice) if checkpoint_practice is not None else None
            self.checkpoint_quiz_correct = int(checkpoint_quiz_correct) if checkpoint_quiz_correct is not None else None

    class GenerateRequest:
        def __init__(
            self,
            lesson_text: str,
            course_name: str = "",
            session_label: str = "",
            students: List[Any] | None = None,
        ):
            if lesson_text is None or not isinstance(lesson_text, str):
                raise ValueError("lesson_text phải là chuỗi ký tự")
            if students is None or not isinstance(students, list):
                raise ValueError("students phải là danh sách")
            self.lesson_text = lesson_text
            self.course_name = str(course_name or "")
            self.session_label = str(session_label or "")
            self.students = [
                s if isinstance(s, StudentInput) else StudentInput(**s)
                for s in students
            ]

    class GeneratedComment:
        def __init__(self, id: int, comment: str):
            self.id = int(id)
            self.comment = str(comment)

        def model_dump(self) -> dict:
            return {"id": self.id, "comment": self.comment}

    class GenerateResponse:
        def __init__(self, comments: List[GeneratedComment], mock_mode: bool = False):
            self.comments = list(comments)
            self.mock_mode = mock_mode

        def model_dump(self) -> dict:
            return {
                "mock_mode": self.mock_mode,
                "comments": [
                    c.model_dump() if hasattr(c, "model_dump") else {"id": c.id, "comment": c.comment}
                    for c in self.comments
                ]
            }


SYSTEM_RULES = """
Bạn viết nhận xét cuối buổi thay cho một thầy giáo nam đang dạy học viên K12 tại MindX.
Toàn bộ nhận xét phải viết bằng tiếng Việt đầy đủ dấu, đúng chính tả; không viết tiếng Việt không dấu.
Viết bằng giọng của chính thầy: gần gũi, điềm đạm, rõ ý, như lời thầy ghi lại sau giờ học để con và phụ huynh đọc.
Giới tính chỉ xác định cách xưng hô; không làm giọng văn cứng nhắc hay áp đặt.

GIỌNG VĂN:
- Gọi học viên là "con". Khi cần tự xưng, dùng "thầy"; không dùng "cô", "thầy cô", "giáo viên" hoặc "chúng tôi" để chỉ người viết.
- Không cần nhắc "thầy" ở mọi đoạn. Có thể viết thẳng "Con cần...", "Khi làm bài, con nên..."; dùng "thầy" khi lời nhắc cần gần gũi hơn.
- Dùng từ quen thuộc, câu ngắn vừa phải, mỗi câu nói một ý. Giữ thuật ngữ bài học khi cần, không diễn giải dài dòng.
- Hạn chế câu cảm thán; thông thường không dùng dấu chấm than. Không dùng emoji, lời tung hô hoặc khẩu hiệu động viên.
- Khen đúng việc đã làm và góp ý đúng điểm cần sửa. Tránh các cụm sáo rỗng như "phát huy tối đa tiềm năng", "hành trình khám phá", "bứt phá", "tỏa sáng", "chinh phục thử thách", "vô cùng xuất sắc".
- Không kết đoạn bằng lời chúc hay câu động viên chung chung như "Thầy tin con sẽ ngày càng tiến bộ", "Hãy cố gắng hơn nữa nhé". Nếu cần nhắc, nói rõ con nên làm gì.
- Tránh mở đầu máy móc "Trong buổi học hôm nay..." ở tất cả học viên, tránh lặp lại nguyên đề bài. Chỉ nhắc phần nội dung liên quan đến nhận xét.
- Viết trực tiếp cho con. Không tự chuyển thành lời giao việc cho phụ huynh hoặc khuyên mua thiết bị, cài thêm phần mềm.
- Không cố tìm từ đồng nghĩa cho mọi học viên. Có thể dùng lại thuật ngữ chuyên môn; chỉ thay cách diễn đạt khi phù hợp dữ liệu.

BẮT BUỘC:
- Mỗi nhận xét có đúng 3 phần, theo thứ tự:
  **Điểm mạnh:** ...

  **Điểm cần cải thiện:** ...

  **Lời khuyên:** ...
- Bám sát nội dung buổi học được cung cấp.
- Tuân thủ quy tắc bài tập theo mã lớp trong yêu cầu: ROB không có bài tập về nhà; C4K có bài tập trên Denise. Quy tắc này áp dụng cả phần lời khuyên và góp ý cần cải thiện.
- Không bịa hành vi, mức độ hiểu bài, kết quả thực hành nếu dữ liệu đầu vào không nói điều đó.
- Tag/ghi chú của giáo viên là bằng chứng để mô tả hành vi hoặc năng lực.
- Mức đánh giá tổng quát như "Tốt" không tự chứng minh con hoàn thành bài, hiểu bài hay tham gia tích cực. Khi không có tag/ghi chú cụ thể, không khẳng định các kết quả này.
- Nếu học viên vắng, nêu rõ không có quan sát trực tiếp và gợi ý ôn bù; không suy diễn kết quả buổi học từ mức đánh giá mặc định.
- Nếu dữ liệu có checkpoint, dùng điểm năng lực/thực hành/trắc nghiệm như bằng chứng cụ thể; không tự suy diễn nguyên nhân điểm số.
- Nếu không có tag/ghi chú đủ cụ thể, dùng cách diễn đạt thận trọng như "Con đã được làm quen...", "Con cần tiếp tục luyện..." thay vì khẳng định quá mức.
- Không đưa việc thiếu dữ liệu vào nhận xét bằng các câu như "Thầy chưa ghi nhận điểm cần sửa", "Chưa có thông tin đánh giá". Khi chưa có lỗi cụ thể, phần cần cải thiện là một lời nhắc luyện kỹ năng liên quan đến bài học, không gán cho con một lỗi chưa được quan sát.
- "Điểm cần cải thiện" không được quá nặng nề; phải có tính xây dựng.
- "Lời khuyên" nêu một hoặc hai việc nhỏ con có thể làm với kiến thức, bài tập đã học. Không đưa ra yêu cầu luyện tập xa với nội dung buổi học.
- Tránh lặp nguyên câu giữa các học viên.
- Mỗi phần thường hai hoặc ba câu; cả nhận xét thường khoảng 110-150 từ. Viết đủ ý để phụ huynh hiểu con đã học gì và cần luyện gì, không chỉ nêu một câu khái quát cho mỗi phần.
- Phần điểm mạnh gắn quan sát được cung cấp với một nội dung hoặc thao tác trong bài. Phần cần cải thiện giải thích rõ điểm cần chú ý, thay vì chỉ nói "cần cố gắng". Phần lời khuyên hướng dẫn một hoặc hai bước luyện tập cụ thể và cách tự kiểm tra kết quả.
- Khi dữ liệu ít, có thể giải thích thêm kiến thức hoặc cách ôn bài liên quan; không bịa tình tiết, kéo dài lời khen hay lặp lại cùng một ý để đủ số từ.
- Không ghi tên học viên vì tên được giữ cục bộ trên trình duyệt.
- Chỉ tạo nhận xét cho học viên có trong danh sách ID đầu vào.

VÍ DỤ VỀ GIỌNG VĂN (chỉ học cách diễn đạt, không sao chép tình tiết):
Nếu ghi chú cho biết con đã tạo được lớp và đối tượng, nhưng còn nhầm thuộc tính với phương thức:
**Điểm mạnh:** Con đã tạo được lớp và đối tượng trong bài thực hành, làm đúng các bước khởi tạo đã học. Đây là phần nền tảng để con tập mô tả thông tin và hành động của một đối tượng trong chương trình.

**Điểm cần cải thiện:** Con còn nhầm giữa thuộc tính và phương thức khi viết lớp. Con cần phân biệt thuộc tính dùng để lưu thông tin, còn phương thức mô tả hành động. Khi viết bài, con nên xác định hai phần này trước rồi mới đặt tên và thêm mã lệnh.

**Lời khuyên:** Con mở lại bài trên lớp, đánh dấu các thuộc tính và phương thức rồi chạy thử từng phần. Sau đó, con thử thay đổi một giá trị thuộc tính và gọi một phương thức để đối chiếu kết quả. Chỗ nào chưa rõ, con ghi lại để buổi sau hỏi thầy.

Trước khi trả kết quả, đọc lại để bỏ lời khen chung chung, câu cảm thán và chi tiết không có bằng chứng. Giữ nguyên ba tiêu đề và định dạng JSON được yêu cầu.
""".strip()


RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "comments": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "integer"},
                    "comment": {"type": "string"},
                },
                "required": ["id", "comment"],
            },
        }
    },
    "required": ["comments"],
}


def get_api_key() -> str:
    load_env_file(override=False)
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key or key in ("your_gemini_api_key_here", "api_key_here"):
        raise HTTPException(
            status_code=500,
            detail="Thiếu GEMINI_API_KEY trong backend/.env hoặc biến môi trường.",
        )
    return key


def get_client():
    key = get_api_key()
    if HAS_GOOGLE_GENAI:
        return genai.Client(api_key=key, http_options=types.HttpOptions(timeout=45000))
    return {"api_key": key}


def configured_models() -> List[str]:
    load_env_file(override=False)
    raw = os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip()
    models = [raw or DEFAULT_GEMINI_MODEL, *FALLBACK_GEMINI_MODELS]
    unique = []
    for model in models:
        model = model.strip()
        if model and model not in unique:
            unique.append(model)
    return unique


def is_model_not_found(exc: Exception) -> bool:
    message = str(exc).lower()
    return (
        "404" in message
        or "not_found" in message
        or "model not found" in message
        or ("not found" in message and "model" in message)
    )


def is_retryable_upstream_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(
        marker in message
        for marker in [
            "429",
            "500",
            "502",
            "503",
            "504",
            "deadline",
            "rate limit",
            "resource_exhausted",
            "timeout",
            "temporarily",
            "unavailable",
            "upstream",
            "overloaded",
        ]
    )


def chunked(items: List[dict], size: int):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def parse_json(text: str):
    """Fallback parser in case the SDK/model wraps JSON unexpectedly."""
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{[\s\S]*\}", text)
        if not match:
            raise
        return json.loads(match.group(0))


def generation_config(student_count: int, system_rules=SYSTEM_RULES, response_schema=RESPONSE_SCHEMA):
    max_output_tokens = min(32768, max(4096, student_count * 750))
    if HAS_GOOGLE_GENAI:
        return types.GenerateContentConfig(
            system_instruction=system_rules,
            response_mime_type="application/json",
            response_schema=response_schema,
            temperature=0.75,
            max_output_tokens=max_output_tokens,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )
    return {
        "max_output_tokens": max_output_tokens,
        "temperature": 0.75,
    }


def build_prompt(req: GenerateRequest, students: List[dict]) -> str:
    return f"""
Thông tin lớp (không dùng để suy đoán thêm):
- Mã/tên lớp: {req.course_name or '(không xác định)'}
- Buổi: {req.session_label or '(không xác định)'}

Quy tắc bài tập của hệ lớp (bắt buộc tuân thủ):
{course_homework_rules(req.course_name)}

Nội dung buổi học:
{req.lesson_text}

Dữ liệu đánh giá theo ID học viên:
{json.dumps(students, ensure_ascii=False)}

Hãy tạo đúng {len(students)} nhận xét. Mỗi ID phải xuất hiện đúng một lần.
""".strip()


def build_mock_comments(req: GenerateRequest, students: List[dict]) -> dict:
    lesson_summary = " ".join(req.lesson_text.strip().split())
    if len(lesson_summary) > 160:
        lesson_summary = lesson_summary[:157].rstrip() + "..."

    comments = []
    for index, student in enumerate(students):
        sid = int(student["id"])
        attendance = student.get("attendance") or "Có mặt"
        level = student.get("level") or "Tốt"
        tags = student.get("tags") or []
        note = (student.get("note") or "").strip()
        checkpoint = student.get("checkpoint")

        tag_phrase = (
            f"Ghi nhận trên lớp cho thấy con thể hiện tốt các điểm: {', '.join(tags)}."
            if tags
            else "Trong giờ học, con đã được làm quen và thực hành theo đúng tiến độ nội dung của buổi học."
        )
        note_phrase = f" Giáo viên ghi nhận thêm: {note}." if note else ""
        checkpoint_phrase = ""
        if isinstance(checkpoint, dict):
            ability = checkpoint.get("ability_score")
            practice = checkpoint.get("practice_score")
            quiz = checkpoint.get("quiz_correct")
            quiz_total = checkpoint.get("quiz_total") or 10
            checkpoint_phrase = (
                f" Ở bài đánh giá định kỳ (checkpoint), con đạt điểm năng lực {ability}/5, "
                f"điểm thực hành {practice}/5 và trả lời đúng {quiz}/{quiz_total} câu trắc nghiệm."
            )

        if attendance == "Vắng":
            strengths = (
                f"**Điểm mạnh:** Trong buổi học với nội dung {lesson_summary}, con vắng mặt nên chưa trực tiếp "
                f"tham gia hoạt động tại lớp.{note_phrase}"
            )
            improve = (
                "**Điểm cần cải thiện:** Con cần xem lại phần lý thuyết và bài tập của buổi học để không bị hổng "
                "kiến thức khi bước sang nội dung tiếp theo."
            )
            advice = (
                "**Lời khuyên:** Con hãy dành khoảng 20-30 phút ở nhà xem lại tài liệu tổng kết buổi học, làm thử "
                "phần bài về nhà và chủ động nhắn giáo viên nếu có bước thao tác nào chưa rõ."
            )
        else:
            level_intro = {
                "Xuất sắc": "Con nắm bắt rất vững trọng tâm buổi học",
                "Tốt": "Con tiếp thu tốt nội dung chính của buổi học",
                "Khá": "Con đã nắm được các bước cơ bản của buổi học",
                "Cần cố gắng": "Con đã bước đầu làm quen với nội dung của buổi học",
            }.get(level, "Con tiếp thu tốt nội dung chính của buổi học")

            strengths = (
                f"**Điểm mạnh:** {level_intro} xoay quanh chủ đề: {lesson_summary}. "
                f"{tag_phrase}{checkpoint_phrase}{note_phrase}"
            )
            if level in ("Cần cố gắng", "Khá") or any("Cần" in t for t in tags):
                improve = (
                    f"**Điểm cần cải thiện:** Con cần tiếp tục rèn sự cẩn thận khi thực hành từng bước và chủ động "
                    f"kiểm tra lại kết quả sau khi hoàn thành yêu cầu trong bài ({'nhịp độ ổn định hơn' if index % 2 == 0 else 'thao tác chính xác hơn'})."
                )
            else:
                improve = (
                    f"**Điểm cần cải thiện:** Con có thể rèn thêm thói quen tự kiểm tra lại chi tiết bài làm và thử "
                    f"mở rộng thêm phương án xử lý để sản phẩm hoàn thiện sâu hơn (góc nhìn #{index + 1})."
                )
            advice = (
                f"**Lời khuyên:** Khi ôn bài ở nhà, con hãy thực hành lại các nội dung thuộc phần {lesson_summary}, "
                f"hoàn thành bài về nhà đầy đủ và ghi chú lại các câu hỏi phát sinh để trao đổi cùng thầy cô ở buổi tới."
            )

        if course_family(req.course_name) == 'ROB':
            advice = "**Lời khuyên:** Buổi học tiếp theo, con hãy trao đổi với thầy về phần chưa rõ và thực hành lại từng bước tại lớp để thầy hướng dẫn thêm."
        elif course_family(req.course_name) == 'C4K':
            advice += " Con kiểm tra và hoàn thành các bài tập được giao trên Denise."

        comments.append(
            {
                "id": sid,
                "comment": f"{strengths}\n\n{improve}\n\n{advice}",
            }
        )
    return {"comments": comments}


def _call_gemini_rest(api_key: str, model: str, prompt: str, student_count: int, system_rules=SYSTEM_RULES, response_schema=RESPONSE_SCHEMA) -> str:
    cfg = generation_config(student_count, system_rules, response_schema)
    max_tokens = cfg["max_output_tokens"] if isinstance(cfg, dict) else cfg.max_output_tokens
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    body = {
        "systemInstruction": {"parts": [{"text": system_rules}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.75,
            "maxOutputTokens": max_tokens,
            "responseMimeType": "application/json",
            "responseSchema": response_schema,
        },
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {exc.code}: {err_body}") from exc

    candidates = payload.get("candidates") or []
    for candidate in candidates:
        parts = (candidate.get("content") or {}).get("parts") or []
        texts = [p.get("text", "") for p in parts if isinstance(p, dict) and p.get("text")]
        if texts:
            return "".join(texts)
    raise RuntimeError("Gemini không trả về nội dung văn bản.")


def _request_gemini_json(client, model, prompt, student_count, system_rules, response_schema):
    if HAS_GOOGLE_GENAI and not isinstance(client, dict):
        response = client.models.generate_content(
            model=model, contents=prompt,
            config=generation_config(student_count, system_rules, response_schema),
        )
        if not response.text:
            raise RuntimeError("Gemini không trả về nội dung văn bản.")
        return parse_json(response.text)
    text = _call_gemini_rest(client["api_key"], model, prompt, student_count, system_rules, response_schema)
    return parse_json(text)


def call_gemini_json(client: Any, prompt: str, student_count: int, system_rules=SYSTEM_RULES, response_schema=RESPONSE_SCHEMA):
    last_error = None
    tried_models = []
    for model in configured_models():
        tried_models.append(model)
        for attempt in range(MAX_RETRIES_PER_MODEL):
            try:
                data = _request_gemini_json(client, model, prompt, student_count, system_rules, response_schema)
                return ensure_vietnamese_json(data, lambda original: _request_gemini_json(
                    client, model, repair_prompt(original), student_count, REPAIR_RULES, response_schema,
                ))
            except Exception as exc:
                last_error = exc
                if is_model_not_found(exc):
                    break
                if is_retryable_upstream_error(exc) and attempt < MAX_RETRIES_PER_MODEL - 1:
                    time.sleep(2 ** (attempt + 1))
                    continue
                break

        if last_error is None:
            break
        if not is_model_not_found(last_error) and not is_retryable_upstream_error(last_error):
            break

    error = str(last_error).lower()
    if isinstance(last_error, VietnameseTextError):
        reason = str(last_error)
    elif any(marker in error for marker in ("api_key", "api key", "permission_denied", "401", "403")):
        reason = "Kiểm tra khóa Gemini mới và quyền truy cập của dự án trong Google AI Studio."
    elif "429" in error or "resource_exhausted" in error:
        reason = "Đã chạm giới hạn lượt gọi hoặc hạn mức Gemini. Kiểm tra quota rồi thử lại."
    elif last_error and is_model_not_found(last_error):
        reason = "Dự án chưa truy cập được model. Kiểm tra GEMINI_MODEL trong backend/.env."
    elif last_error and is_retryable_upstream_error(last_error):
        reason = "Gemini đang phản hồi chậm hoặc tạm thời không khả dụng. Thử lại sau."
    else:
        reason = "Gemini từ chối yêu cầu hoặc trả dữ liệu không hợp lệ."
    raise HTTPException(502, f"Lỗi Gemini ({', '.join(tried_models)}). {reason}")


@app.get("/health")
def health():
    load_env_file(override=False)
    key = os.getenv("GEMINI_API_KEY", "").strip()
    key_configured = bool(key and key not in ("your_gemini_api_key_here", "api_key_here"))
    mock_mode = os.getenv("MXRA_MOCK_GEMINI", "").strip()
    return {
        "ok": True,
        "provider": "gemini",
        "model": configured_models()[0],
        "fallback_models": configured_models()[1:],
        "api_key_configured": key_configured,
        "mock_mode": mock_mode.lower() in ("1", "true", "mock", "error", "mismatch"),
    }


def generate(req: GenerateRequest):
    if not req.lesson_text or not req.lesson_text.strip():
        raise HTTPException(status_code=400, detail="lesson_text đang trống")
    if not req.students:
        raise HTTPException(status_code=400, detail="Không có học viên")

    input_ids = [int(s.id) for s in req.students]
    if len(set(input_ids)) != len(input_ids):
        raise HTTPException(status_code=400, detail="Danh sách học viên có ID bị trùng lặp")

    compact_students = [
        {
            "id": int(s.id),
            "attendance": s.attendance,
            "level": s.level,
            "tags": s.tags,
            "note": s.note,
            "checkpoint": {
                "ability_score": s.checkpoint_ability,
                "practice_score": s.checkpoint_practice,
                "quiz_correct": s.checkpoint_quiz_correct,
                "quiz_total": 10 if s.checkpoint_quiz_correct is not None else None,
            } if any(v is not None for v in [
                s.checkpoint_ability,
                s.checkpoint_practice,
                s.checkpoint_quiz_correct,
            ]) else None,
        }
        for s in req.students
    ]

    mock_mode = os.getenv("MXRA_MOCK_GEMINI", "").strip().lower()
    if mock_mode == "error":
        raise HTTPException(
            status_code=502,
            detail=(
                "Lỗi gọi Gemini API. "
                f"Đã thử model: {', '.join(configured_models())}. "
                "Lỗi cuối: Simulated upstream Gemini error"
            ),
        )
    if mock_mode == "mismatch":
        raise HTTPException(
            status_code=502,
            detail=f"Gemini trả thiếu/sai ID. expected={sorted(input_ids)}, got=[]",
        )

    is_mock = mock_mode in ("1", "true", "mock")
    client = None if is_mock else get_client()
    by_id: dict[int, GeneratedComment] = {}

    try:
        for student_batch in chunked(compact_students, DEFAULT_BATCH_SIZE):
            data = build_mock_comments(req, student_batch) if is_mock else call_gemini_json(
                client=client,
                prompt=build_prompt(req, student_batch),
                student_count=len(student_batch),
            )
            expected = {s["id"] for s in student_batch}
            items = data.get("comments") if isinstance(data, dict) else None
            if not isinstance(items, list) or len(items) != len(expected):
                raise HTTPException(502, "Gemini trả thiếu hoặc thừa nhận xét. Hãy thử tạo lại.")
            for item in items:
                sid = item.get("id") if isinstance(item, dict) else None
                comment = item.get("comment") if isinstance(item, dict) else None
                if type(sid) is not int or sid not in expected or not isinstance(comment, str) or not comment.strip():
                    raise HTTPException(502, "Gemini trả sai ID hoặc nhận xét trống. Hãy thử tạo lại.")
                expected.remove(sid)
                by_id[sid] = GeneratedComment(id=sid, comment=comment.strip())
    finally:
        if client is not None and not isinstance(client, dict):
            client.close()

    return GenerateResponse(comments=[by_id[sid] for sid in input_ids], mock_mode=is_mock)


def generate_parent_summary(req: ParentSummaryRequest):
    try:
        validate_summary_request(req)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    mode = os.getenv("MXRA_MOCK_GEMINI", "").strip().lower()
    is_mock = mode in ("1", "true", "mock")
    if mode in ("error", "mismatch"):
        raise HTTPException(502, "Lỗi tạo tổng kết mô phỏng. Hãy thử lại.")
    client = None if is_mock else get_client()
    try:
        if is_mock:
            data = {
                "title": req.lesson_title or "Ôn tập và thực hành",
                "lesson_points": [req.lesson_text.strip()],
                "remarks": [
                    "Bản thử: buổi học giới thiệu các nội dung nêu trên và dành thời gian cho phần thực hành.",
                    "Bản thử: nội dung thực hành giúp các con luyện cách áp dụng kiến thức vào bài tập.",
                    "Bản thử: các con có thể xem lại từng bước và ghi lại phần chưa rõ để trao đổi với thầy.",
                ],
                "homework": ["Các con xem lại bài và thực hành lại các bước đã học."],
            }
        else:
            data = call_gemini_json(client, summary_prompt(req), 2, SUMMARY_RULES, SUMMARY_SCHEMA)
        try:
            markdown = format_parent_summary(req, data)
        except ValueError as exc:
            raise HTTPException(502, str(exc)) from exc
        return ParentSummaryResponse(markdown=markdown, mock_mode=is_mock)
    finally:
        if client is not None and not isinstance(client, dict):
            client.close()


# Chrome may stop the extension worker if a fetch waits too long for headers.
_job_lock = Lock()
_job_pool = ThreadPoolExecutor(max_workers=2)
_jobs = {}


def require_json(content_type: str = "") -> None:
    if content_type.split(";", 1)[0].strip().lower() != "application/json":
        raise HTTPException(415, "Yêu cầu phải gửi JSON (Content-Type: application/json).")


def start_job(req: GenerateRequest):
    return submit_job(generate, req)


def start_summary_job(req: ParentSummaryRequest):
    try:
        validate_summary_request(req)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return submit_job(generate_parent_summary, req)


def submit_job(worker, req):
    with _job_lock:
        now = time.monotonic()
        for job_id, (started, task) in list(_jobs.items()):
            if task.done() and now - started > 600:
                del _jobs[job_id]
        if sum(not task.done() for _, task in _jobs.values()) >= 2 or len(_jobs) >= 50:
            raise HTTPException(429, "Backend đang bận. Hãy thử lại sau.")
        job_id = uuid4().hex
        _jobs[job_id] = (now, _job_pool.submit(worker, req))
        return {"job_id": job_id}


def job_status(job_id: str):
    with _job_lock:
        job = _jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Không tìm thấy lượt tạo nhận xét. Hãy tạo lại.")
        task = job[1]
        if not task.done():
            return {"status": "pending"}
        del _jobs[job_id]
    return {"status": "done", "result": task.result().model_dump()}


if HAS_FASTAPI:
    def require_json_header(content_type: str = Header("")):
        require_json(content_type)

    app.post("/generate", response_model=GenerateResponse, dependencies=[Depends(require_json_header)])(generate)
    app.post("/generate/jobs", dependencies=[Depends(require_json_header)])(start_job)
    app.post("/summary", response_model=ParentSummaryResponse, dependencies=[Depends(require_json_header)])(generate_parent_summary)
    app.post("/summary/jobs", dependencies=[Depends(require_json_header)])(start_summary_job)
    app.get("/generate/jobs/{job_id}")(job_status)


class _StdlibBackendHandler(BaseHTTPRequestHandler):
    def _send_json(self, status_code: int, payload: Any) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send_json(200, health())
            return
        if path.startswith("/generate/jobs/"):
            try:
                self._send_json(200, job_status(path.removeprefix("/generate/jobs/")))
            except HTTPException as exc:
                self._send_json(exc.status_code, {"detail": exc.detail})
            except Exception:
                self._send_json(500, {"detail": "Lỗi máy chủ nội bộ. Xem cửa sổ backend."})
                raise
            return
        self._send_json(404, {"detail": "Not Found"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path not in ("/generate", "/generate/jobs", "/summary", "/summary/jobs"):
            self._send_json(404, {"detail": "Not Found"})
            return

        try:
            require_json(self.headers.get("Content-Type", ""))
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length).decode("utf-8") if length > 0 else "{}"
            body = json.loads(raw_body)
            if not isinstance(body, dict):
                raise ValueError("Payload phải là JSON object")
            req = ParentSummaryRequest(**body) if path.startswith("/summary") else GenerateRequest(**body)
        except HTTPException as exc:
            self._send_json(exc.status_code, {"detail": exc.detail})
            return
        except Exception as exc:
            self._send_json(422, {"detail": f"Dữ liệu đầu vào không hợp lệ: {exc}"})
            return

        try:
            if path.startswith("/summary"):
                data = start_summary_job(req) if path.endswith("/jobs") else generate_parent_summary(req).model_dump()
            else:
                data = start_job(req) if path == "/generate/jobs" else generate(req).model_dump()
            self._send_json(200, data)
        except HTTPException as exc:
            self._send_json(exc.status_code, {"detail": exc.detail})
        except Exception:
            self._send_json(500, {"detail": "Lỗi máy chủ nội bộ. Xem cửa sổ backend."})
            raise

    def log_message(self, fmt: str, *args: Any) -> None:
        return


def run_stdlib_server(host: str = "127.0.0.1", port: int = 8787) -> None:
    server = ThreadingHTTPServer((host, port), _StdlibBackendHandler)
    print(f"MindX Review Assistant API running on http://{host}:{port} (stdlib HTTP server)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
