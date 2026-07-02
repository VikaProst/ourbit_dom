@echo off
chcp 65001 >nul
title SQUAD TERMINAL
cd /d "%~dp0"

echo ================================================
echo   SQUAD TERMINAL - запуск
echo ================================================
echo.

rem --- ищем Python ---
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY ( where python >nul 2>nul && set "PY=python" )
if not defined PY ( if exist "C:\Python314\python.exe" set "PY=C:\Python314\python.exe" )
if not defined PY (
  echo [!] Python не найден.
  echo     Установи Python 3 с https://www.python.org/downloads/
  echo     ВАЖНО: при установке поставь галочку "Add Python to PATH".
  echo     Потом запусти этот файл снова.
  echo.
  pause
  exit /b 1
)

echo Проверяю библиотеки (первый раз ~минуту)...
%PY% -m pip install --quiet --upgrade curl_cffi websockets 2>nul

echo Проверяю обновления терминала...
%PY% -u updater.py

echo.
echo ================================================
echo   Терминал открывается: http://localhost:8777
echo   НЕ закрывай это чёрное окно, пока торгуешь.
echo   Чтобы выключить терминал - закрой это окно.
echo ================================================
echo.

start "" http://localhost:8777
%PY% -u server.py

echo.
echo Терминал остановлен.
pause
