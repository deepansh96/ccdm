@echo off
rem The `ccdm` command for PowerShell and cmd: finds Python and runs ccdm.py beside
rem this file. Git Bash runs scripts/ccdm instead. Python is found by the same rules
rem as pythonCommand() in scripts/platform/tools.js. Keep the three in step.
rem Free text must not come through here: the arguments can run & and | as commands.
setlocal
set "PYTHONUTF8=1"
set "_PY="
goto :find

rem Whether %1 can be run: a .cmd or .bat needs a shell, the Store stub is not Python.
:usable
if /i "%~x1"==".cmd" exit /b 1
if /i "%~x1"==".bat" exit /b 1
set "_CANDIDATE=%~1"
if not "%_CANDIDATE:\WindowsApps\=%"=="%_CANDIDATE%" exit /b 1
exit /b 0

:override
call :usable "%~2" && (
  set "_PY=%~2"
  exit /b
)
echo ccdm: ignoring %~1=%~2: it is a .cmd, a .bat or the Microsoft Store stub, not Python>&2
exit /b

rem The launcher only finds the interpreter, which then runs without it.
:launcher
if defined _PY exit /b
if not exist "%~1" exit /b
call :usable "%~1" || exit /b
for /f "delims=" %%I in ('call "%~1" -3 -c "import sys; sys.stdout.write(sys.executable)" 2^>nul') do (
  call :usable "%%I" && set "_PY=%%I"
)
exit /b

:interpreter
if defined _PY exit /b
if not exist "%~1" exit /b
call :usable "%~1" && set "_PY=%~1"
exit /b

:find
if defined CCDM_PYTHON call :override CCDM_PYTHON "%CCDM_PYTHON%"
if not defined _PY if defined CCDM_REMINDER_PYTHON call :override CCDM_REMINDER_PYTHON "%CCDM_REMINDER_PYTHON%"
if defined _PY goto :run
rem Only absolute PATH entries: cmd would otherwise look in the current directory first.
set "_SEARCH=%PATH:"=%"
for %%D in ("%_SEARCH:;=" "%") do if /i "%%~fD"=="%%~D" call :launcher "%%~D\py.exe"
if defined _PY goto :run
for %%D in ("%_SEARCH:;=" "%") do if /i "%%~fD"=="%%~D" call :interpreter "%%~D\python.exe"
if defined _PY goto :run
echo ccdm: No usable Python was found. Install Python, or set CCDM_PYTHON to its path.>&2
exit /b 127

:run
"%_PY%" "%~dp0ccdm.py" %*
