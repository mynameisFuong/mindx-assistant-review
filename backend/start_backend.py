import argparse
import os
from pathlib import Path
import sys

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

BACKEND_DIR = Path(__file__).resolve().parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

ENV_FILE = BACKEND_DIR / ".env"

parser = argparse.ArgumentParser(description="Start the local MindX Review Assistant backend.")
parser.add_argument("--mock", action="store_true", help="Generate sample reviews without a Gemini key.")
args = parser.parse_args()
if args.mock:
    os.environ["MXRA_MOCK_GEMINI"] = "1"

try:
    import app
except (ImportError, ModuleNotFoundError) as exc:
    requirements = BACKEND_DIR / "requirements.txt"
    print(f"Cannot import backend app: {exc}")
    print("Install/update backend dependencies with the same Python interpreter:")
    print(f'"{sys.executable}" -m pip install -r "{requirements}"')
    raise SystemExit(1) from exc

try:
    import uvicorn
except ModuleNotFoundError:
    uvicorn = None

settings = app.health()
if settings["mock_mode"]:
    print("Chế độ thử: dùng nhận xét mẫu. Extension không lưu kết quả thử vào LMS.")
elif not settings["api_key_configured"]:
    print(f"Chưa có GEMINI_API_KEY. Điền khóa vào {ENV_FILE} rồi khởi động lại, hoặc dùng --mock.")

if uvicorn is not None and getattr(app, "HAS_FASTAPI", False):
    uvicorn.run("app:app", host="127.0.0.1", port=8787, reload=False, app_dir=str(BACKEND_DIR))
else:
    requirements = BACKEND_DIR / "requirements.txt"
    print(
        "Notice: FastAPI/Uvicorn chưa được cài trong Python hiện tại; "
        "khởi động chế độ HTTP server tương thích chuẩn tại http://127.0.0.1:8787."
    )
    print(f'Để cài đầy đủ gói trong requirements.txt: "{sys.executable}" -m pip install -r "{requirements}"')
    app.run_stdlib_server(host="127.0.0.1", port=8787)
