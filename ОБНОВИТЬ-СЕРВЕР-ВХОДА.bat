@echo off
cd /d "%~dp0"
echo ======================================================
echo   OBNOVIT SERVER VHODA (login + parol)
echo   Nuzhno odin raz posle etogo obnovleniya.
echo   Vvedesh parol servera odin raz.
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
echo   Gotovo. Teper server prinimaet vhod po loginu+parolyu.
echo   Vydat login drugu: VYDAT-LOGIN.bat
echo ======================================================
goto end
:err
echo.
echo [!] Ne poluchilos. Proveryay parol servera i internet.
echo     Server pri etom prodolzhaet rabotat na staroy versii.
:end
pause
