@echo off
cd /d "%~dp0"
echo ==================================================
echo   OBNOVIT SERVER PRIYOMA BAGOV (activation_server)
echo   Nuzhno odin raz - chtoby bagi ot druzey dohodili.
echo ==================================================
echo.
echo 1/2 Zalivayu novyy activation_server.py na server...
scp activation_server.py root@45.153.247.114:/tmp/activation_server.new
if errorlevel 1 goto err
echo.
echo 2/2 Nahozhu i perezapuskayu server aktivacii...
ssh root@45.153.247.114 "T=$(ps aux | grep -o '[^ ]*activation_server.py' | head -1); [ -z $T ] && T=$HOME/ourbit_dom/activation_server.py; D=$(dirname $T); mkdir -p $D; cp /tmp/activation_server.new $T; echo TARGET=$T; systemctl restart activation 2>/dev/null || (pkill -f activation_server.py; sleep 1; cd $D && nohup python3 -u activation_server.py >act.log 2>&1 &); sleep 2; echo -n 'HEALTH: '; curl -s localhost:8790/health; echo."
if errorlevel 1 goto err
echo.
echo ==================================================
echo   Gotovo! Bagi ot druzey teper prinimayutsya.
echo   Smotret bagi: zapusti  POSMOTRET-BAGI.bat
echo ==================================================
goto end
:err
echo.
echo [!] Ne poluchilos. Proveryay parol servera i internet.
:end
pause
