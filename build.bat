@echo off
REM ============================================================
REM  Pi Chat build script
REM    Outputs:
REM      1. VSCode extension -> apps\vscode\pi-chat-*.vsix
REM      2. Electron client  -> apps\electron\dist\Pi Chat Setup *.exe
REM    Usage: build.bat [skip]
REM              skip         - skip npm install
REM              env SKIP_INSTALL=1 also skips install
REM ============================================================
setlocal

cd /d "%~dp0"

echo.
echo [build] === Pi Chat build ===
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
set "SKIP=0"
if "%SKIP_INSTALL%"=="1" set "SKIP=1"
if /I "%~1"=="skip" set "SKIP=1"
if "%SKIP%"=="1" (
    echo [build] skip npm install
) else (
    echo [build] installing vscode deps...
    pushd apps\vscode
    call npm install
    if errorlevel 1 ( echo [err] vscode npm install failed & popd & exit /b 1 )
    popd
    echo [build] installing electron deps...
    pushd apps\electron
    call npm install
    if errorlevel 1 ( echo [err] electron npm install failed & popd & exit /b 1 )
    popd
)

REM ---- build VSCode extension -> .vsix ----
echo.
echo [build] building VSCode extension...
pushd apps\vscode
call npm run package
if errorlevel 1 ( echo [err] VSIX packaging failed & popd & exit /b 1 )
popd

set "VSIX="
for %%f in (apps\vscode\pi-chat-*.vsix) do set "VSIX=%%f"
if not defined VSIX (
    echo [err] VSIX artifact not found
    exit /b 1
)

REM ---- build Electron client -> .exe ----
echo.
echo [build] building Electron client via electron-builder win nsis...
pushd apps\electron
call npm run dist
if errorlevel 1 ( echo [err] EXE packaging failed & popd & exit /b 1 )
popd

set "EXE="
for %%f in (apps\electron\dist\*.exe) do (
    echo %%f | findstr /i "uninstall" >nul
    if errorlevel 1 set "EXE=%%f"
)
if not defined EXE (
    echo [err] EXE artifact not found under apps\electron\dist
    exit /b 1
)

REM ---- summary ----
echo.
echo [build] === build done ===
echo   VSIX: %VSIX%
echo   EXE : %EXE%
echo.
endlocal
