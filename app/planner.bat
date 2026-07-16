@echo off
rem Launch the Weekly Planner: start the server, then open the page.
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
    echo Virtual environment not found. Run setup first (see README.md^).
    pause
    exit /b 1
)

rem Server keeps running in its own window; no activation needed when
rem invoking the venv's python.exe directly.
start "Weekly Planner server" .venv\Scripts\python.exe server.py

rem Give the server a moment to come up, then open the app.
ping -n 3 127.0.0.1 >nul
start "" http://localhost:3366
