@echo off
rem Andy prompt library - native messaging launcher for the disk backup host.
rem Chrome runs this file directly. It may write NOTHING to stdout except the
rem length-prefixed JSON reply that backup_host.py produces, so every diagnostic
rem message here goes to stderr only.
rem
rem Python is resolved at run time instead of being baked in at registration
rem time: a Python upgrade / reinstall / move used to break the whole backup
rem silently (the red "!" on the toolbar icon).
rem
rem Candidate order: PATH python.exe -> per-user / system Python3* dirs ->
rem Microsoft Store python3*.exe aliases -> py launcher. Every candidate is
rem verified with -c "import sys;print(sys.version_info[0])"; anything that is
rem not a working Python 3 (App execution alias stub, Python 2, broken install)
rem is skipped and the next candidate is tried.
setlocal enableextensions
set "SCRIPT=%~dp0backup_host.py"
if not exist "%SCRIPT%" (
  echo [andy-backup] backup_host.py is missing next to this launcher 1>&2
  exit /b 1
)

set "PY="
set "PYARG="
set "PYVER="
set "CAND="
set "CARG="

rem 1) python.exe on PATH, but skip the "App execution alias" under
rem    %LOCALAPPDATA%\Microsoft\WindowsApps: that one may just open the
rem    Microsoft Store, and if it prints anything to stdout the native-messaging
rem    protocol breaks (Chrome only ever shows "Native host has exited").
for /f "delims=" %%P in ('where python.exe 2^>nul') do (
  if not defined PY (
    echo %%~fP | find /i "\WindowsApps\" >nul
    if errorlevel 1 call :try "%%~fP" ""
  )
)

rem 2) regular per-user / system Python 3.x installs, any version number
if not defined PY for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if not defined PY if exist "%%~fD\python.exe" call :try "%%~fD\python.exe" ""
if not defined PY for /d %%D in ("C:\Python3*") do if not defined PY if exist "%%~fD\python.exe" call :try "%%~fD\python.exe" ""
if not defined PY for /d %%D in ("%ProgramFiles%\Python3*") do if not defined PY if exist "%%~fD\python.exe" call :try "%%~fD\python.exe" ""

rem 3) Microsoft Store python aliases (survive Store updates, need no PATH entry).
rem    Enumerated dynamically so a future Python 3.15 is still found.
if not defined PY for %%A in ("%LOCALAPPDATA%\Microsoft\WindowsApps\python3*.exe") do if not defined PY call :try "%%~fA" ""

rem 4) py launcher, last resort; also skip its Store alias.
if not defined PY (
  for /f "delims=" %%P in ('where py.exe 2^>nul') do (
    if not defined PY (
      echo %%~fP | find /i "\WindowsApps\" >nul
      if errorlevel 1 call :try "%%~fP" "-3"
    )
  )
)

if not defined PY (
  echo [andy-backup] Python 3 not found, disk backup cannot run. Install Python 3 and run backup-host\register again. 1>&2
  exit /b 1
)

"%PY%" %PYARG% -u "%SCRIPT%"
exit /b %errorlevel%

:try
rem %1 = candidate executable, %2 = extra args (e.g. -3). Only the first working
rem Python 3 wins; everything else falls through to the next candidate.
if defined PY goto :eof
if "%~1"=="" goto :eof
set "CAND=%~1"
set "CARG=%~2"
rem Validate by piping the version number into findstr: stdout/stderr never
rem touch the native-messaging channel, a Store stub / Python 2 / broken
rem install prints nothing or "2" and is rejected, and concurrent host
rem instances (multiple Chrome profiles) need no shared temp file.
"%CAND%" %CARG% -c "import sys;print(sys.version_info[0])" 2>nul <nul | findstr /r /c:"^3$" >nul
if not errorlevel 1 (
  set "PY=%CAND%"
  set "PYARG=%CARG%"
)
goto :eof
