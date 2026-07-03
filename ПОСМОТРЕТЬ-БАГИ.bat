@echo off
cd /d "%~dp0"
rem Otkryvaet stranicu so vsemi bagami ot druzey (s foto). Secret chitaetsya iz admin_secret.txt.
set /p SEC=<admin_secret.txt
start "" "http://45.153.247.114:8790/bugs?secret=%SEC%"
