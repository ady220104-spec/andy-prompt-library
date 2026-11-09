@echo off
chcp 65001 >nul
setlocal
echo ================================================================
echo   Andy Prompt Library - repair / register disk backup helper
echo ================================================================
echo.
set "PS1="
for %%F in ("%~dp0backup-host\*.ps1") do if not defined PS1 set "PS1=%%~fF"
if not defined PS1 (
  echo [ERROR] No registration script found: "%~dp0backup-host\*.ps1"
  echo         The backup-host folder is missing or was moved/deleted.
  echo         Restore the backup-host folder next to this file, then run again.
  echo.
  pause
  exit /b 1
)
echo Running: "%PS1%"
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
set "RC=%errorlevel%"
echo.
if not "%RC%"=="0" (
  echo [ERROR] Registration / self-check FAILED with exit code %RC%.
  echo         Read the FAIL lines above. Common causes:
  echo           - backup-host\backup_host.py or backup_host.bat is missing
  echo           - Python 3 is not installed or not working
  echo           - the backup folder is not writable ^(run the script with -BackupDir to choose another folder^)
  echo           - manifest/registry write was blocked by security software
  echo         Nothing beyond what the script reported was changed.
  echo.
  pause
  exit /b %RC%
)
echo Next steps:
echo   1. chrome://extensions  -^>  Refresh the "Andy prompt library" extension
echo   2. Close and reopen the side panel
echo   3. Right-click the toolbar icon -^> retry disk backup
echo      ^(or open the side panel menu and click the backup row^)
echo.
pause
exit /b 0
