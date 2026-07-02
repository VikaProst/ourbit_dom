@echo off
cd /d "%~dp0"
echo ================================================
echo   VYDAT KLYUCH DRUGU
echo ================================================
echo.
set "FRIEND="
set /p "FRIEND=Imya druga (napishi i Enter): "
echo.
C:\Python314\python.exe make_key.py "%FRIEND%"
echo.
echo ------------------------------------------------
echo Skopiruy KLYUCH vyshe (strochka posle "КЛЮЧ") i otdai drugu.
echo ------------------------------------------------
echo.
pause
