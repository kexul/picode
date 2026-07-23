@echo off
echo ========================================
echo   Pi Chat VSIX Build
echo ========================================
echo.

echo [1/3] npm install...
call npm install
if errorlevel 1 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
)
echo.

echo [2/3] Compile TypeScript...
if exist out rmdir /s /q out
call npx tsc -p ./
if errorlevel 1 (
    echo [ERROR] Compile failed
    pause
    exit /b 1
)
echo.

echo [3/3] Package VSIX...
call npx @vscode/vsce package --no-dependencies --allow-missing-repository
if errorlevel 1 (
    echo [ERROR] Package failed
    pause
    exit /b 1
)
echo.
echo ========================================
echo   Done!
echo ========================================
pause
