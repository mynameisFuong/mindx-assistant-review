import os
from pathlib import Path
import sys

try:
    from dotenv import load_dotenv
    import uvicorn
except ModuleNotFoundError as exc:
    requirements = Path(__file__).with_name("requirements.txt")
    print(f"Missing Python package: {exc.name}")
    print("Install dependencies with the same Python interpreter you use to start the backend:")
    print(f'"{sys.executable}" -m pip install -r "{requirements}"')
    print("On Windows, you can also run:")
    print("py -3.14 -m pip install -r requirements.txt")
    print("py -3.14 start_backend.py")
    raise SystemExit(1) from exc

load_dotenv(Path(__file__).with_name('.env'))

try:
    import app  # noqa: F401
except (ImportError, ModuleNotFoundError) as exc:
    requirements = Path(__file__).with_name("requirements.txt")
    print(f"Cannot import backend app: {exc}")
    print("Install/update backend dependencies with the same Python interpreter:")
    print(f'"{sys.executable}" -m pip install -r "{requirements}"')
    raise SystemExit(1) from exc

uvicorn.run('app:app', host='127.0.0.1', port=8787, reload=False)
