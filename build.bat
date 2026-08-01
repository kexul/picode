@echo off
REM ============================================================
REM    Outputs:
REM      1. VSCode extension -> pi-chat-*.vsix
REM    Usage: build.bat [skip]
REM              skip        - skip npm install
REM              env SKIP_INSTALL=1 also skips install
REM    Examples:
REM              build.bat                 build vsix (with install)
REM              build.bat skip            build vsix, skip install
REM ============================================================
setlocal enabledelayedexpansion

cd /d "%~dp0"

REM ---- parse args ----
set "SKIP=0"
if "%SKIP_INSTALL%"=="1" set "SKIP=1"
:parse
if "%~1"=="" goto parsed
if /I "%~1"=="skip"      ( set "SKIP=1"          & shift & goto parse )
echo [err] unknown argument: %~1
exit /b 1
:parsed

echo.
echo [build]   install=%SKIP_INSTALL%
echo.

REM ---- prerequisites ----
where node >nul 2>&1
if errorlevel 1 (
    echo [err] node not found
    exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
    echo [err] npm not found
    exit /b 1
)
where npx >nul 2>&1
if errorlevel 1 (
    echo [err] npx not found
    exit /b 1
)

REM ---- dependencies ----
if "%SKIP%"=="1" (
    echo [build] skip npm install
) else (
    echo [build] installing deps...
    call npm install
    if errorlevel 1 ( echo [err] npm install failed & exit /b 1 )
)

REM ---- build VSCode extension -> .vsix ----
echo.
echo [build] building VSCode extension...
call npm run package
if errorlevel 1 ( echo [err] VSIX packaging failed & exit /b 1 )

set "VSIX="
for %%f in (pi-chat-*.vsix) do set "VSIX=%%f"
if not defined VSIX (
    echo [err] VSIX artifact not found
    exit /b 1
)

REM ---- summary ----
echo.
echo [build] === build done ===
echo   VSIX: %VSIX%
echo.
endlocal
