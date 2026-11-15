@echo off
REM ============================================================
REM    Outputs:
REM      1. VSCode extension -> pi-chat-*.vsix
REM      2. global pichat command (the standalone backend)
REM      3. dist\PiChat.exe (double-click to start the backend, tray icon included)
REM      4. android app APK -> android\app\build\outputs\apk\debug\app-debug.apk
REM         (it packs media\ with the fingerprints the backend serves, so it has to be
REM          rebuilt whenever media\ changed; serve it to the phone with: npm run apk)
REM    Usage: build.bat [skip] [skip-pichat] [skip-apk]
REM              skip          - skip npm install
REM              skip-pichat   - skip the global pichat install
REM              skip-apk      - skip the Android app APK
REM              env SKIP_INSTALL=1 also skips npm install
REM    Examples:
REM              build.bat                 build + install pichat + build APK
REM              build.bat skip            skip npm install
REM              build.bat skip-pichat     build vsix + exe only
REM ============================================================
setlocal enabledelayedexpansion

cd /d "%~dp0"

REM ---- parse args ----
set "SKIP=0"
set "SKIP_PICHAT=0"
set "SKIP_APK=0"
if "%SKIP_INSTALL%"=="1" set "SKIP=1"
:parse
if "%~1"=="" goto parsed
if /I "%~1"=="skip"      ( set "SKIP=1"          & shift & goto parse )
if /I "%~1"=="skip-pichat" ( set "SKIP_PICHAT=1" & shift & goto parse )
if /I "%~1"=="skip-apk"  ( set "SKIP_APK=1"     & shift & goto parse )
echo [err] unknown argument: %~1
exit /b 1
:parsed

echo.
echo [build] skip-npm-install=%SKIP% skip-pichat=%SKIP_PICHAT% skip-apk=%SKIP_APK%
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
REM out/ was just compiled, install straight from it; the panel html comes from the backend.
if "%SKIP_PICHAT%"=="1" (
    echo [build] skip global pichat install
) else (
    echo.
    echo [build] installing global pichat command...
    call npm i -g .
    if errorlevel 1 ( echo [err] global pichat install failed & exit /b 1 )
)

REM ---- Android app APK (packs media\ -> whoever uses the app gets the fresh UI) ----
if "%SKIP_APK%"=="1" echo [build] skip android apk
if not "%SKIP_APK%"=="1" call :build_apk

REM ---- summary ----
echo.
echo [build] === build done ===
echo   VSIX: %VSIX%
echo   exe:  dist\PiChat.exe (double-click it to start Pi Chat)
if "%APK_RESULT%"=="0" echo   apk:  android\app\build\outputs\apk\debug\app-debug.apk  - npm run apk serves it to the phone
if not "%SKIP_PICHAT%"=="1" echo   pichat: installed (if one is running, restart it to pick up the new build)
echo.
endlocal
exit /b 0

REM ============================================================
REM   Build the Android app APK.
REM   Needs Android SDK + JDK 17; without them this step just prints a line and moves on
REM   (the extension / pichat / exe above are already built by then).
REM
REM   Written flat on purpose: an echo with parentheses in the text, sitting inside a
REM   ( ... ) block, makes cmd cut the block short - the rest of the step then silently
REM   doesn't run at all.
REM ============================================================
:build_apk
set "GRADLE_BAT="
REM gradle on PATH, else the copy gradle already downloaded into the user dir
for %%i in (gradle.bat) do set "GRADLE_BAT=%%~$PATH:i"
if defined GRADLE_BAT goto :apk_build
for /d %%a in ("%USERPROFILE%\.gradle\wrapper\dists\gradle-*") do call :apk_scan_dist "%%~a"
if defined GRADLE_BAT goto :apk_build
echo [build] gradle not found - skipping the APK. Building it needs Android SDK and JDK 17.
goto :eof

REM 往下一层：<dists>\<版本目录>\<哈希>\gradle-<版本>\bin\gradle.bat
:apk_scan_dist
for /d %%b in ("%~1\*") do call :apk_scan_hash "%%~b"
goto :eof

:apk_scan_hash
for /d %%c in ("%~1\gradle-*") do if exist "%%~c\bin\gradle.bat" set "GRADLE_BAT=%%~c\bin\gradle.bat"
goto :eof

:apk_build
echo.
echo [build] building Android app APK...
pushd android
REM keep gradle away from the proxy settings in the global ~/.gradle/gradle.properties
set "GRADLE_USER_HOME_OLD=%GRADLE_USER_HOME%"
set "GRADLE_USER_HOME=%CD%\.gradle-home"
call "%GRADLE_BAT%" assembleDebug --console=plain -q
set "APK_RESULT=%errorlevel%"
set "GRADLE_USER_HOME=%GRADLE_USER_HOME_OLD%"
popd
if not "%APK_RESULT%"=="0" echo [warn] APK build failed - see gradle output above; the rest is unaffected
if "%APK_RESULT%"=="0" echo [build] APK: android\app\build\outputs\apk\debug\app-debug.apk
goto :eof
