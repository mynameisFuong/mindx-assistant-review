import os
from pathlib import Path
from dotenv import load_dotenv
import uvicorn

load_dotenv(Path(__file__).with_name('.env'))
uvicorn.run('app:app', host='127.0.0.1', port=8787, reload=False)
