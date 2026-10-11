@echo off
REM ============================================================
REM    Outputs:
REM      1. VSCode extension -> pi-chat-*.vsix
REM    Usage: build.bat [skip] [skip-pichat]
REM              skip        - skip npm install
REM              skip-pichat - skip the global pichat install
REM              env SKIP_INSTALL=1 also skips npm install
REM    Examples:
REM              build.bat                 build + install pichat
REM              build.bat skip            skip npm install
REM              build.bat skip-pichat     build vsix only
REM ============================================================
setlocal enabledelayedexpansion

cd /d "%~dp0"

REM ---- parse args ----
set "SKIP=0"
set "SKIP_PICHAT=0"
if "%SKIP_INSTALL%"=="1" set "SKIP=1"
:parse
if "%~1"=="" goto parsed
if /I "%~1"=="skip"      ( set "SKIP=1"          & shift & goto parse )
if /I "%~1"=="skip-pichat" ( set "SKIP_PICHAT=1" & shift & goto parse )
echo [err] unknown argument: %~1
exit /b 1
:parsed

echo.
echo [build] skip-npm-install=%SKIP% skip-pichat=%SKIP_PICHAT%
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

REM ---- install global pichat command (backend + media, see package.json files) ----
REM out/ 刚刚编译过，直接装；面板的界面文件从后端现取，装好 pichat 面板就是新版
if "%SKIP_PICHAT%"=="1" (
    echo [build] skip global pichat install
) else (
    echo.
    echo [build] installing global pichat command...
    call npm i -g .
    if errorlevel 1 ( echo [err] global pichat install failed & exit /b 1 )
)

REM ---- summary ----
echo.
echo [build] === build done ===
echo   VSIX: %VSIX%
if not "%SKIP_PICHAT%"=="1" echo   pichat: installed (if one is running, restart it to pick up the new build)
echo.
endlocal
