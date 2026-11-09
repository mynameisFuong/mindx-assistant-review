@echo off
setlocal
cd /d "%~dp0"

if not exist "backend\.env" (
    copy /y "backend\.env.example" "backend\.env" >nul
    if errorlevel 1 goto failed
)

if not exist "backend\.venv\Scripts\python.exe" (
    py -3 -m venv "backend\.venv"
    if errorlevel 1 goto failed
)

set "REVIEW_PYTHON=backend\.venv\Scripts\python.exe"
"%REVIEW_PYTHON%" -c "import fastapi, uvicorn, dotenv; from google import genai" >nul 2>&1
if errorlevel 1 (
    "%REVIEW_PYTHON%" -m pip install -r "backend\requirements.txt"
    if errorlevel 1 goto failed
)

"%REVIEW_PYTHON%" "backend\start_backend.py" %*
if errorlevel 1 goto failed
exit /b 0

:failed
echo Could not start MindX Review Assistant. Check the error above.
pause
exit /b 1
