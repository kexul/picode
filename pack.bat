@echo off
REM ============================================================
REM  Pi Chat VSCode 插件 - 一键打包脚本
REM  流程：安装依赖(可选) -> 编译 TypeScript -> 打包为 .vsix
REM  用法：
REM    pack.bat            正常打包
REM    pack.bat install    先执行 npm install 再打包
REM ============================================================
setlocal enabledelayedexpansion

REM 切换到脚本所在目录（项目根目录）
cd /d "%~dp0"

echo(
echo === Pi Chat 打包开始 ===
echo 项目目录: %cd%
echo(

REM 可选：带 install 参数时先安装依赖
if /i "%~1"=="install" (
    echo [1/3] 安装依赖 npm install ...
    call npm install
    if errorlevel 1 goto :fail
) else (
    echo [1/3] 跳过 npm install（如需安装依赖请运行: pack.bat install）
)

echo(
echo [2/3] 编译 TypeScript ...
call npm run compile
if errorlevel 1 goto :fail

echo(
echo [3/3] 打包为 .vsix ...
call npx vsce package --allow-missing-repository
if errorlevel 1 goto :fail

echo(
echo === 打包成功 ===
for %%f in ("*.vsix") do echo   生成: %%~ff  (%%~zf 字节)
echo(
echo 安装命令: code --install-extension pi-chat-0.0.1.vsix
echo(
endlocal
exit /b 0

:fail
echo(
echo *** 打包失败，请查看上方错误信息。 ***
echo(
endlocal
exit /b 1
