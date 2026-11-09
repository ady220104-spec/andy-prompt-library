@echo off
rem Deprecated compatibility wrapper. Use ..\修复备份.cmd instead.
rem Kept so existing shortcuts/docs that call backup-host\register.cmd still work.
call "%~dp0..\修复备份.cmd"
exit /b %errorlevel%
