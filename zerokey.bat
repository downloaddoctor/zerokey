@echo off
title ZeroKey
setlocal enabledelayedexpansion

set "REPO_URL=https://github.com/downloaddoctor/zerokey.git"
set "BRANCH=main"
set "DIR=%~dp0zerokey"
set "HR=----------------------------------------"

echo ZeroKey - Your local AI proxy
echo ==============================

:: ── Step 1: Clone if not already cloned ──
if not exist "%DIR%\.git" (
    echo.
    echo ZeroKey not found. Cloning...
    call :hr
    git clone --progress %REPO_URL% "%DIR%" 2>&1
    call :hr
    if %errorlevel% neq 0 (
        echo Failed to clone. Check your network and git installation.
        pause
        exit /b 1
    )
    cd /d "%DIR%"
    git remote rename origin main 2>nul
    goto install_deps
)

:: ── Step 2: Already cloned ──
cd /d "%DIR%"

:: Missing node_modules — reinstall
if not exist "node_modules\" goto install_deps

:: ── Step 3: Check for updates ──
echo.
echo Checking for updates...
call :hr
git fetch %BRANCH% 2>nul
if %errorlevel% neq 0 (
    echo Could not check for updates (no network?^)
    goto start
)

for /f "delims=" %%i in ('git rev-parse HEAD') do set LOCAL=%%i
for /f "delims=" %%i in ('git rev-parse %BRANCH%/%BRANCH% 2^>nul') do set REMOTE=%%i

if "%REMOTE%"=="" (
    echo Could not reach remote — skipping.
    goto start
)

if "%LOCAL%"=="%REMOTE%" (
    echo Already up to date.
    call :hr
    goto start
)

echo.
echo ============================================
echo  UPDATE AVAILABLE
echo ============================================
echo.
set /p DOUPDATE="Update now? (y/n): "
if /i "!DOUPDATE!"=="y" (
    echo.
    echo Pulling latest changes...
    call :hr
    git pull %BRANCH% %BRANCH%
    call :hr
    goto install_deps
)
echo Skipping update.
goto start

:: ── Shared dependency installer ──
:install_deps
echo.
echo Installing dependencies...
call :hr
call pnpm install
call :hr
if %errorlevel% neq 0 (
    echo Failed to install dependencies. Is pnpm installed?
    pause
    exit /b 1
)

:start
echo.
echo Starting ZeroKey...
call :hr
node server.js
pause
endlocal

:: ── Helper: horizontal rule ──
:hr
echo %HR%
exit /b
