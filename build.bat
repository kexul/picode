@echo off
REM ============================================================
REM    Outputs:
REM      1. VSCode extension -> pi-chat-*.vsix
REM      2. auto install to VSCode (code --install-extension)
REM      3. auto reload VSCode window (vscode:// URI handler in extension)
REM    Usage: build.bat [skip] [noauto]
REM              skip        - skip npm install
REM              noauto      - build vsix only, skip install/reload
REM              env SKIP_INSTALL=1 also skips npm install
REM    Examples:
REM              build.bat                 build + install + reload VSCode
REM              build.bat skip            skip npm install
REM              build.bat noauto          build vsix only
REM ============================================================
setlocal enabledelayedexpansion

cd /d "%~dp0"

REM ---- parse args ----
set "SKIP=0"
set "NOAUTO=0"
if "%SKIP_INSTALL%"=="1" set "SKIP=1"
:parse
if "%~1"=="" goto parsed
if /I "%~1"=="skip"      ( set "SKIP=1"          & shift & goto parse )
if /I "%~1"=="noauto"    ( set "NOAUTO=1"         & shift & goto parse )
echo [err] unknown argument: %~1
exit /b 1
:parsed

echo.
echo [build] skip-npm-install=%SKIP%  auto-deploy=%NOAUTO%
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

REM ---- auto deploy: install to VSCode + reload window ----
if "%NOAUTO%"=="1" goto summary
where code.cmd >nul 2>&1
if errorlevel 1 (
    echo [warn] 'code.cmd' CLI not in PATH, skip install/reload
    goto summary
)

echo.
echo [build] installing to VSCode: %VSIX%
call code.cmd --install-extension "%VSIX%" --force
if errorlevel 1 goto install_fail

echo [build] reloading VSCode window via URI...
start "" "vscode://local.pi-chat-vscode/reloadWindow"
echo [hint] if the window did not reload (first install only), reload once manually: Ctrl+Shift+P -^> Reload Window
goto summary

:install_fail
echo [err] install failed, run manually: code.cmd --install-extension "%VSIX%" --force
goto summary

:summary
REM ---- summary ----
echo.
echo [build] === build done ===
echo   VSIX: %VSIX%
echo.
endlocal
