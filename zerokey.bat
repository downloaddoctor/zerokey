@echo off
title ZeroKey
setlocal enabledelayedexpansion

:: -- Enable ANSI/VT escape processing + color palette --
reg add HKCU\Console /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >nul 2>nul
for /f %%e in ('echo prompt $E ^| cmd') do set "ESC=%%e"
set "C_RESET=!ESC![0m"
set "C_DIM=!ESC![2m"
set "C_BOLD=!ESC![1m"
set "C_CYAN=!ESC![36m"
set "C_GREEN=!ESC![32m"
set "C_YELLOW=!ESC![33m"
set "C_RED=!ESC![31m"
set "C_GRAY=!ESC![90m"

set "REPO_URL=https://github.com/downloaddoctor/zerokey.git"
set "BRANCH=main"
set "DIR=%~dp0zerokey"
set "HR=----------------------------------------"

:: -- Portable toolchain (installed on demand into .zerokey-tools\) --
:: Bump NODE_VER / GIT_TAG / GIT_ZIP when newer releases ship.
set "TOOLS=%~dp0.zerokey-tools"
set "NODE_VER=v22.14.0"
set "NODE_ZIP=node-%NODE_VER%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/%NODE_ZIP%"
set "GIT_TAG=2.47.1.windows.1"
set "GIT_ZIP=MinGit-2.47.1-64-bit.zip"
set "GIT_URL=https://github.com/git-for-windows/git/releases/download/v%GIT_TAG%/%GIT_ZIP%"

call :banner

:: -- Step 0: Ensure git / node / npm / pnpm are available --
call :section "Setup - portable toolchain"
call :ensure_git
if errorlevel 1 goto fail
call :ensure_node
if errorlevel 1 goto fail
call :ensure_pnpm
if errorlevel 1 goto fail
call :ok "Toolchain ready"

:: -- Step 1: Clone if not already cloned --
if not exist "%DIR%\.git" (
    call :section "Clone - fetching ZeroKey"
    call :warn "ZeroKey not found. Cloning %REPO_URL% ..."
    git clone --progress %REPO_URL% "%DIR%" 2>&1
    if !errorlevel! neq 0 (
        call :err "Failed to clone. Check your network and git installation."
        pause
        exit /b 1
    )
    call :ok "Cloned to %DIR%"
    cd /d "%DIR%"
    goto install_deps
)

:: -- Step 2: Already cloned --
cd /d "%DIR%"

:: Missing node_modules - reinstall
if not exist "node_modules\" goto install_deps

:: -- Step 3: Check for updates --
call :section "Updates - checking origin/%BRANCH%"
call :warn "Fetching remote..."
git fetch origin 2>nul
set "FETCH_RC=!errorlevel!"
if !FETCH_RC! neq 0 (
    call :warn "Could not check for updates (no network?)"
    goto start
)

for /f "delims=" %%i in ('git rev-parse HEAD') do set LOCAL=%%i
for /f "delims=" %%i in ('git rev-parse origin/%BRANCH% 2^>nul') do set REMOTE=%%i

if "%REMOTE%"=="" (
    call :warn "Could not reach remote - skipping."
    goto start
)

if "%LOCAL%"=="%REMOTE%" (
    call :ok "Already up to date."
    goto start
)

echo.
echo !C_BOLD!!C_YELLOW![ UPDATE AVAILABLE ]!C_RESET!
echo !C_GRAY!local:  !C_DIM!%LOCAL:~0,8%!C_RESET!
echo !C_GRAY!remote: !C_DIM!%REMOTE:~0,8%!C_RESET!
echo.
set /p DOUPDATE="  Update now? (y/N): "
if /i "!DOUPDATE!"=="y" (
    call :section "Pull - fast-forward origin/%BRANCH%"
    git fetch origin %BRANCH%
    git pull origin %BRANCH% --ff-only
    if !errorlevel! neq 0 (
        call :warn "Fast-forward failed - local history diverged."
        call :warn "Resetting local repo to match origin/%BRANCH% (local changes discarded)."
        git reset --hard origin/%BRANCH%
    )
    call :ok "Repo updated."
    goto install_deps
)
call :warn "Skipping update."
goto start

:: -- Shared dependency installer --
:install_deps
call :section "Dependencies - pnpm install --prod"
call pnpm install --prod
if !errorlevel! neq 0 (
    call :err "Failed to install dependencies."
    pause
    exit /b 1
)
call :ok "Dependencies installed."

:start
call :section "Start - node server.js"
node scripts/start.js
pause
endlocal
exit /b 0

:: -- UI helpers --
:banner
echo.
echo   !C_CYAN! ______             _  __          !C_RESET!
echo   !C_CYAN!^|__  /___ _ __ ___ ^| ^|/ /___ _   _ !C_RESET!
echo   !C_CYAN!  / // _ \ '__/ _ \^| ' // _ \ ^| ^| ^|!C_RESET!
echo   !C_CYAN! / /^|  __/ ^| ^| (_) ^| . \  __/ ^|_^| ^|!C_RESET!
echo   !C_CYAN!/____\___^|_^|  \___/^|_^|\_\___^|\__, ^|!C_RESET!
echo   !C_CYAN!                            ^|___/ !C_RESET!
echo   !C_GRAY!  ZeroKey - local AI proxy!C_RESET!
echo.
exit /b

:section
echo.
echo !C_BOLD!!C_CYAN![ %~1 ]!C_RESET!
exit /b

:hr
echo !C_GRAY!%HR%!C_RESET!
exit /b

:ok
echo !C_GREEN![OK]!C_RESET! %~1
exit /b

:warn
echo !C_YELLOW![..]!C_RESET! %~1
exit /b

:err
echo !C_RED![XX]!C_RESET! %~1
exit /b

:: -- Failure path --
:fail
echo.
call :err "Setup failed. See errors above."
pause
exit /b 1

:: -- Ensure Git is available (system PATH or %TOOLS%\git) --
:ensure_git
where git >nul 2>nul
if not errorlevel 1 exit /b 0

if exist "%TOOLS%\git\cmd\git.exe" (
    set "PATH=%TOOLS%\git\cmd;%PATH%"
    goto verify_git
)

call :section "Git - portable install"
call :warn "Git not found. Downloading portable Git..."
if not exist "%TOOLS%" mkdir "%TOOLS%"
call :warn "Downloading Git..."
call :download "%GIT_URL%" "%TOOLS%\git.zip"
if errorlevel 1 exit /b 1

if not exist "%TOOLS%\git" mkdir "%TOOLS%\git"
tar -xf "%TOOLS%\git.zip" -C "%TOOLS%\git"
if errorlevel 1 (
    call :err "Failed to extract Git archive."
    exit /b 1
)
del "%TOOLS%\git.zip" >nul 2>nul
set "PATH=%TOOLS%\git\cmd;%PATH%"

:verify_git
call git --version >nul 2>nul
if errorlevel 1 (
    call :err "git is not runnable. Check %TOOLS%\git\cmd."
    exit /b 1
)
call :ok "Git ready."
exit /b 0

:: -- Ensure Node.js + npm are available (system PATH or %TOOLS%\node) --
:ensure_node
where node >nul 2>nul
if not errorlevel 1 (
    where npm >nul 2>nul
    if not errorlevel 1 exit /b 0
)

if exist "%TOOLS%\node\node.exe" (
    set "PATH=%TOOLS%\node;%PATH%"
    goto verify_node
)

call :section "Node.js - portable install"
call :warn "Node.js not found. Downloading portable Node.js %NODE_VER%..."
if not exist "%TOOLS%" mkdir "%TOOLS%"
call :warn "Downloading Node.js..."
call :download "%NODE_URL%" "%TOOLS%\node.zip"
if errorlevel 1 exit /b 1

if not exist "%TOOLS%\node" mkdir "%TOOLS%\node"
tar -xf "%TOOLS%\node.zip" -C "%TOOLS%\node" --strip-components=1
if errorlevel 1 (
    call :err "Failed to extract Node.js archive."
    exit /b 1
)
del "%TOOLS%\node.zip" >nul 2>nul
set "PATH=%TOOLS%\node;%PATH%"

:verify_node
node --version >nul 2>nul
if errorlevel 1 (
    call :err "node is not runnable. Check %TOOLS%\node."
    exit /b 1
)
call npm --version >nul 2>nul
if errorlevel 1 (
    call :err "npm is not runnable. Check %TOOLS%\node\npm.cmd."
    exit /b 1
)
call :ok "Node.js + npm ready."
exit /b 0

:: -- Ensure pnpm is available (installs into the active Node prefix) --
:ensure_pnpm
where pnpm >nul 2>nul
if not errorlevel 1 exit /b 0

call :section "pnpm - install"
call :warn "pnpm not found. Installing via npm..."
call npm install -g pnpm
if errorlevel 1 (
    call :err "Failed to install pnpm."
    exit /b 1
)
call :ok "pnpm ready."
exit /b 0

:: -- Helper: download a URL to a file using curl --
:download
where curl >nul 2>nul
if errorlevel 1 (
    echo ERROR: curl is not available. Windows 10 1803+ is required.
    exit /b 1
)
curl -fsSL --retry 3 -o "%~2" "%~1"
if errorlevel 1 (
    echo ERROR: Download failed.
    exit /b 1
)
exit /b 0
