@echo off
pushd "%~dp0"
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY if exist "C:\Python314\python.exe" set "PY=C:\Python314\python.exe"
if not defined PY (
  echo Ustanovi Python 3 s python.org - galochka Add to PATH.
  pause
  exit /b 1
)
echo Proveryayu biblioteki...
%PY% -m pip install --quiet --upgrade curl_cffi websockets 2>nul
echo Proveryayu obnovleniya...
%PY% -u updater.py
echo.
echo Terminal: http://localhost:8777  -  ne zakryvay eto okno
start "" http://localhost:8777
%PY% -u server.py
pause
