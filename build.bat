@echo off
REM ============================================================
REM    Outputs:
REM      1. VSCode extension -> pi-chat-*.vsix
REM      2. single-file backend -> dist\pichat.exe (double-click to run, see README)
REM      3. desktop window -> desktop\PiChat\bin\Release\net8.0-windows\PiChat.exe
REM      4. android app -> android\app\build\outputs\apk\debug\app-debug.apk
REM    Usage: build.bat [skip] [skip-pichat] [skip-desktop] [skip-android]
REM              skip          - skip npm install
REM              skip-pichat   - skip the global pichat install
REM              skip-desktop  - skip the desktop window (WPF)
REM              skip-android  - skip the android app
REM              env SKIP_INSTALL=1 also skips npm install
REM    Examples:
REM              build.bat                 build + install pichat
REM              build.bat skip            skip npm install
REM              build.bat skip-pichat     build vsix only
REM              build.bat skip-desktop skip-android
REM ============================================================
setlocal enabledelayedexpansion

cd /d "%~dp0"

REM ---- parse args ----
set "SKIP=0"
set "SKIP_PICHAT=0"
set "SKIP_DESKTOP=0"
set "SKIP_ANDROID=0"
if "%SKIP_INSTALL%"=="1" set "SKIP=1"
:parse
if "%~1"=="" goto parsed
if /I "%~1"=="skip"      ( set "SKIP=1"          & shift & goto parse )
if /I "%~1"=="skip-pichat" ( set "SKIP_PICHAT=1" & shift & goto parse )
if /I "%~1"=="skip-desktop" ( set "SKIP_DESKTOP=1" & shift & goto parse )
if /I "%~1"=="skip-android" ( set "SKIP_ANDROID=1" & shift & goto parse )
echo [err] unknown argument: %~1
exit /b 1
:parsed

echo.
echo [build] skip-npm-install=%SKIP% skip-pichat=%SKIP_PICHAT% skip-desktop=%SKIP_DESKTOP% skip-android=%SKIP_ANDROID%
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

REM ---- build single-file backend -> dist\pichat.exe ----
REM Not `npm run exe`: that runs npm run build first, whose clean step deletes the vsix made above.
REM out\ and bin\tray.exe / bin\shot.exe are fresh from npm run package, so pack them directly.
REM A running pichat.exe holds that file and blocks the rebuild; the error says so, close it and rerun.
REM (Keep this file ASCII-only: cmd reads it in the OEM code page, UTF-8 bytes can swallow a CRLF.)
echo.
echo [build] building single-file backend (dist\pichat.exe)...
call node scripts/build-exe.mjs
if errorlevel 1 ( echo [err] exe packaging failed & exit /b 1 )

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

REM ---- desktop window (WPF, .NET 8) -> desktop\PiChat\bin\Release\net8.0-windows\PiChat.exe ----
REM Missing tooling is only a skip (the vsix and the exe above are the grown-up outputs);
REM a real compile error is an error.
echo.
if "%SKIP_DESKTOP%"=="1" (
    echo [build] skip desktop window
) else if not exist "desktop\PiChat\PiChat.csproj" (
    echo [build] desktop window: desktop\PiChat is not here, skipped
) else (
    where dotnet >nul 2>&1
    if errorlevel 1 (
        echo [build] desktop window: dotnet not found ^(needs .NET 8 SDK^), skipped
    ) else (
        echo [build] building desktop window ^(desktop\PiChat^)...
        call dotnet build -c Release "desktop\PiChat\PiChat.csproj"
        if errorlevel 1 ( echo [err] desktop window build failed ^(see the text above^) & exit /b 1 )
    )
)

REM ---- android app -> android\app\build\outputs\apk\debug\app-debug.apk ----
REM Needs a JDK 17+ and the Android SDK (android\local.properties sdk.dir, or ANDROID_HOME);
REM one of them missing is a skip with a note, a real build error is an error.
echo.
if "%SKIP_ANDROID%"=="1" (
    echo [build] skip android app
) else if not exist "android\gradlew.bat" (
    echo [build] android app: android\gradlew.bat is not here, skipped
) else (
    set "SDK="
    if exist "android\local.properties" (
        for /f "usebackq tokens=1,* delims==" %%A in ("android\local.properties") do (
            if /I "%%A"=="sdk.dir" set "SDK=%%B"
        )
    )
    if not defined SDK if defined ANDROID_HOME set "SDK=%ANDROID_HOME%"
    if not defined SDK if defined ANDROID_SDK_ROOT set "SDK=%ANDROID_SDK_ROOT%"
    where java >nul 2>&1
    set "HAS_JAVA=%errorlevel%"
    if not defined SDK (
        echo [build] android app: Android SDK not found ^(write sdk.dir=... into android\local.properties, or set ANDROID_HOME^), skipped
    ) else if not "!HAS_JAVA!"=="0" (
        echo [build] android app: java not found ^(needs JDK 17+^), skipped
    ) else (
        echo [build] building android app ^(android^)...
        pushd android
        call gradlew.bat assembleDebug
        set "ANDROID_RC=!errorlevel!"
        popd
        if not "!ANDROID_RC!"=="0" ( echo [err] android app build failed ^(see the text above^; more in android\README.md^) & exit /b 1 )
    )
)

REM ---- summary ----
echo.
echo [build] === build done ===
echo   VSIX: %VSIX%
echo   EXE : dist\pichat.exe
if not "%SKIP_DESKTOP%"=="1" if exist "desktop\PiChat\bin\Release\net8.0-windows\PiChat.exe" echo   DESKTOP: desktop\PiChat\bin\Release\net8.0-windows\PiChat.exe
if not "%SKIP_ANDROID%"=="1" if exist "android\app\build\outputs\apk\debug\app-debug.apk" echo   APK : android\app\build\outputs\apk\debug\app-debug.apk
if not "%SKIP_PICHAT%"=="1" echo   pichat: installed (if one is running, restart it to pick up the new build)
echo.
endlocal
