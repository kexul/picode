@echo off
REM ============================================================
REM    Outputs:
REM      1. VSCode extension -> apps\vscode\pi-chat-*.vsix
REM      2. Electron client  -> apps\electron\dist\Setup *.exe
REM    Usage: build.bat [target] [skip]
REM              target      - vsix | electron | all (default: all)
REM              skip        - skip npm install
REM              env SKIP_INSTALL=1 also skips install
REM    Examples:
REM              build.bat                 build both
REM              build.bat vsix            vscode only
REM              build.bat electron        electron only
REM              build.bat vsix skip       vscode only, skip install
REM ============================================================
setlocal enabledelayedexpansion

cd /d "%~dp0"

REM ---- parse args ----
set "TARGET=all"
set "SKIP=0"
if "%SKIP_INSTALL%"=="1" set "SKIP=1"
:parse
if "%~1"=="" goto parsed
if /I "%~1"=="vsix"      ( set "TARGET=vsix"     & shift & goto parse )
if /I "%~1"=="electron"  ( set "TARGET=electron" & shift & goto parse )
if /I "%~1"=="all"       ( set "TARGET=all"      & shift & goto parse )
if /I "%~1"=="skip"      ( set "SKIP=1"          & shift & goto parse )
echo [err] unknown argument: %~1
exit /b 1
:parsed

set "B_VSIX=0"
set "B_ELECTRON=0"
if "%TARGET%"=="all"      ( set "B_VSIX=1" & set "B_ELECTRON=1" )
if "%TARGET%"=="vsix"     ( set "B_VSIX=1" )
if "%TARGET%"=="electron" ( set "B_ELECTRON=1" )

echo.
echo [build]   target=%TARGET%  install=%SKIP_INSTALL flavors: vsix=%B_VSIX% electron=%B_ELECTRON%
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
) else if "%B_VSIX%"=="1" (
    echo [build] installing vscode deps...
    pushd apps\vscode
    call npm install
    if errorlevel 1 ( echo [err] vscode npm install failed & popd & exit /b 1 )
    popd
) else (
    echo [build] skip vscode deps install (vsix not selected)
)
if "%SKIP%"=="1" (
    REM 已提示 skip
) else if "%B_ELECTRON%"=="1" (
    echo [build] installing electron deps...
    pushd apps\electron
    call npm install
    if errorlevel 1 ( echo [err] electron npm install failed & popd & exit /b 1 )
    popd
) else (
    echo [build] skip electron deps install (electron not selected)
)

set "VSIX="
set "EXE="

REM ---- build VSCode extension -> .vsix ----
if "%B_VSIX%"=="1" (
    echo.
    echo [build] building VSCode extension...
    pushd apps\vscode
    call npm run package
    if errorlevel 1 ( echo [err] VSIX packaging failed & popd & exit /b 1 )
    popd

    for %%f in (apps\vscode\pi-chat-*.vsix) do set "VSIX=%%f"
    if not defined VSIX (
        echo [err] VSIX artifact not found
        exit /b 1
    )
)

REM ---- build Electron client -> .exe ----
if "%B_ELECTRON%"=="1" (
    echo.
    echo [build] building Electron client via electron-builder win nsis...
    pushd apps\electron
    call npm run dist
    if errorlevel 1 ( echo [err] EXE packaging failed & popd & exit /b 1 )
    popd

    for %%f in (apps\electron\dist\*.exe) do (
        echo %%f | findstr /i "uninstall" >nul
        if errorlevel 1 set "EXE=%%f"
    )
    if not defined EXE (
        echo [err] EXE artifact not found under apps\electron\dist
        exit /b 1
    )
)

REM ---- code reuse / duplication analysis ----
if "%SKIP_ANALYZE%"=="1" (
    echo [build] skip reuse analysis
) else (
    echo.
    echo [build] reuse / duplication analysis
    call node scripts\analyze-reuse.js
    if errorlevel 1 echo [warn] reuse analysis failed (non-fatal)
)

REM ---- summary ----
echo.
echo [build] === build done ===
if defined VSIX      echo   VSIX: %VSIX%
if defined EXE       echo   EXE : %EXE%
if not defined VSIX  if not defined EXE echo   (nothing built)
echo.
endlocal
