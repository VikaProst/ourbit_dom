@echo off
cd /d "%~dp0"
echo ================================================
echo   VYKATIT OBNOVLENIE DRUZYAM
echo ================================================
echo.
echo 1/3 Peresobirayu spisok faylov (manifest)...
C:\Python314\python.exe publish.py
echo.
echo 2/3 Sohranyayu izmeneniya...
git add -A
git commit -m "obnovlenie terminala"
echo.
echo 3/3 Zalivayu na GitHub...
git push origin main
echo.
echo ================================================
echo Gotovo!
echo U druzey fiks priletit pri sleduyushchem zapuske start.bat
echo (cherez ~5 minut - GitHub obnovlyaet razdachu ne srazu).
echo ================================================
echo.
pause
