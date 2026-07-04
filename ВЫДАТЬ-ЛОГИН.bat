@echo off
cd /d "%~dp0"
echo ================================================
echo   VYDAT LOGIN + PAROL DRUGU
echo ================================================
echo.
set "FRIEND="
set /p "FRIEND=Login druga (napishi i Enter): "
echo.
set "PW="
set /p "PW=Parol (Enter = sluchainyy): "
echo.
C:\Python314\python.exe make_user.py add "%FRIEND%" %PW%
echo.
echo ------------------------------------------------
echo Skopiruy LOGIN i PAROL vyshe (dve strochki) i otdai drugu.
echo Drug vvodit ih v okne vhoda terminala.
echo ------------------------------------------------
echo.
pause
