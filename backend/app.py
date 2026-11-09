import json
import os
import re
import time
from typing import List

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from pydantic import BaseModel, Field

app = FastAPI(title="MindX Review Assistant API", version="0.3.0-gemini")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Keep the default on a generally available Gemini Developer API model. The
# app may still override this via GEMINI_MODEL in backend/.env.
DEFAULT_GEMINI_MODEL = "gemini-3.8-flash"
FALLBACK_GEMINI_MODELS = [
    DEFAULT_GEMINI_MODEL,
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash",
]
DEFAULT_BATCH_SIZE = 8
MAX_RETRIES_PER_MODEL = 3


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


SYSTEM_RULES = """
Bạn là trợ lý viết nhận xét cuối buổi cho học viên K12 của MindX.
Mục tiêu: viết nhận xét tiếng Việt tự nhiên, tích cực, cụ thể, phụ huynh dễ đọc.

BẮT BUỘC:
- Mỗi nhận xét có đúng 3 phần, theo thứ tự:
  **Điểm mạnh:** ...

  **Điểm cần cải thiện:** ...

  **Lời khuyên:** ...
- Dùng cách xưng hô "Con".
- Bám sát nội dung buổi học được cung cấp.
- Không bịa hành vi, mức độ hiểu bài, kết quả thực hành nếu dữ liệu đầu vào không nói điều đó.
- Tag/ghi chú của giáo viên là bằng chứng để mô tả hành vi hoặc năng lực.
- Nếu dữ liệu có checkpoint, dùng điểm năng lực/thực hành/trắc nghiệm như bằng chứng cụ thể; không tự suy diễn nguyên nhân điểm số.
- Nếu không có tag/ghi chú đủ cụ thể, dùng cách diễn đạt thận trọng như "Con đã được làm quen...", "Con cần tiếp tục luyện..." thay vì khẳng định quá mức.
- "Điểm cần cải thiện" không được quá nặng nề; phải có tính xây dựng.
- "Lời khuyên" phải cụ thể, tự nhiên, ngôn ngữ gần gũi, có thể thực hiện được. Thể hiện văn bản giống lời khuyên của giáo viên, hạn chế các câu cảm thán.
- Tránh lặp nguyên câu giữa các học viên.
- Mỗi nhận xét khoảng 90-150 từ.
- Không ghi tên học viên vì tên được giữ cục bộ trên trình duyệt.
- Chỉ tạo nhận xét cho học viên có trong danh sách ID đầu vào.
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


def get_client() -> genai.Client:
    key = os.getenv("GEMINI_API_KEY", "").strip()
    if not key:
        raise HTTPException(
            status_code=500,
            detail="Thiếu GEMINI_API_KEY trong backend/.env hoặc biến môi trường.",
        )
    return genai.Client(api_key=key)


def configured_models() -> List[str]:
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
        or "not found" in message and "model" in message
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


def generation_config(student_count: int) -> types.GenerateContentConfig:
    max_output_tokens = min(32768, max(4096, student_count * 450))
    return types.GenerateContentConfig(
        system_instruction=SYSTEM_RULES,
        response_mime_type="application/json",
        response_schema=RESPONSE_SCHEMA,
        temperature=0.75,
        max_output_tokens=max_output_tokens,
        automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
    )


def build_prompt(req: GenerateRequest, students: List[dict]) -> str:
    return f"""
Thông tin lớp (không dùng để suy đoán thêm):
- Mã/tên lớp: {req.course_name or '(không xác định)'}
- Buổi: {req.session_label or '(không xác định)'}

Nội dung buổi học:
{req.lesson_text}

Dữ liệu đánh giá theo ID học viên:
{json.dumps(students, ensure_ascii=False)}

Hãy tạo đúng {len(students)} nhận xét. Mỗi ID phải xuất hiện đúng một lần.
""".strip()


def call_gemini_json(client: genai.Client, prompt: str, student_count: int):
    last_error = None
    tried_models = []
    for model in configured_models():
        tried_models.append(model)
        for attempt in range(MAX_RETRIES_PER_MODEL):
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=prompt,
                    config=generation_config(student_count),
                )
                if not response.text:
                    raise RuntimeError("Gemini không trả về nội dung văn bản.")
                return parse_json(response.text)
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

    raise HTTPException(
        status_code=502,
        detail=(
            "Lỗi gọi Gemini API. "
            f"Đã thử model: {', '.join(tried_models)}. "
            f"Lỗi cuối: {last_error}"
        ),
    )


@app.get("/health")
def health():
    return {
        "ok": True,
        "provider": "gemini",
        "model": configured_models()[0],
        "fallback_models": configured_models()[1:],
        "api_key_configured": bool(os.getenv("GEMINI_API_KEY", "").strip()),
    }


@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest):
    if not req.lesson_text.strip():
        raise HTTPException(status_code=400, detail="lesson_text đang trống")
    if not req.students:
        raise HTTPException(status_code=400, detail="Không có học viên")

    compact_students = [
        {
            "id": s.id,
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

    client = get_client()
    expected = {s.id for s in req.students}
    output = []
    seen = set()

    for student_batch in chunked(compact_students, DEFAULT_BATCH_SIZE):
        data = call_gemini_json(
            client=client,
            prompt=build_prompt(req, student_batch),
            student_count=len(student_batch),
        )
        items = data.get("comments", []) if isinstance(data, dict) else []

        for item in items:
            try:
                sid = int(item.get("id"))
                comment = str(item.get("comment", "")).strip()
            except Exception:
                continue

            if sid in expected and sid not in seen and comment:
                output.append(GeneratedComment(id=sid, comment=comment))
                seen.add(sid)

    got = {item.id for item in output}
    if got != expected:
        raise HTTPException(
            status_code=502,
            detail=f"Gemini trả thiếu/sai ID. expected={sorted(expected)}, got={sorted(got)}",
        )

    return GenerateResponse(comments=output)
