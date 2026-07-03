@echo off
cd /d "%~dp0"
echo ======================================================
echo   OBNOVIT SERVER AKTIVACII
echo   - dva tvoih IP = admin (aktivaciya bez klyucha)
echo   - priyom bagov ot druzey (vidzhet)
echo   Nuzhno odin raz. Vvedesh parol servera odin raz.
echo ======================================================
echo.
echo 1/3 Zalivayu novyy activation_server.py...
scp activation_server.py root@45.153.247.114:/tmp/act_new.py
if errorlevel 1 goto err
echo.
echo 2/3 Zalivayu skript ustanovki...
scp deploy.py root@45.153.247.114:/tmp/deploy.py
if errorlevel 1 goto err
echo.
echo 3/3 Ustanavlivayu i perezapuskayu na servere...
ssh root@45.153.247.114 "python3 /tmp/deploy.py"
if errorlevel 1 goto err
echo.
echo ======================================================
echo   Gotovo. Tvoi mashiny (213.139.11.65 i 82.208.115.8)
echo   teper aktiviruyutsya vsegda, bez klyucha.
echo   Bagi ot druzey: POSMOTRET-BAGI.bat
echo ======================================================
goto end
:err
echo.
echo [!] Ne poluchilos. Proveryay parol servera i internet.
echo     Server pri etom prodolzhaet rabotat na staroy versii.
:end
pause
