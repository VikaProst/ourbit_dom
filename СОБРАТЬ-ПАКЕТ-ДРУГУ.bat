@echo off
cd /d "%~dp0"
echo ================================================
echo   SOBRAT PAKET DLYA DRUGA (zip na Rabochiy stol)
echo ================================================
echo.
C:\Python314\python.exe make_friend_package.py
echo.
echo ------------------------------------------------
echo Gotovo. Zip lezhit na Rabochem stole:
echo   SQUAD-TERMINAL-dlya-druga.zip
echo Ego i otpravlyay drugu.
echo ------------------------------------------------
echo.
pause
