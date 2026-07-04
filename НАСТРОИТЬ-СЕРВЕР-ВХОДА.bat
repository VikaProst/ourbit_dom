@echo off
cd /d "%~dp0"
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY if exist "C:\Python314\python.exe" set "PY=C:\Python314\python.exe"
if not defined PY (
  echo Ne nayden Python. Ustanovi Python 3 s python.org.
  pause
  exit /b 1
)
%PY% _setup_login_squadbot.py
echo.
pause
