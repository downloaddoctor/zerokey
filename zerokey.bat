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

set "RAW=https://raw.githubusercontent.com/downloaddoctor/zerokey/dist"
set "DIR=%~dp0zerokey"
set "TOOLS=%~dp0.zerokey-tools"
set "NODE_VER=v22.14.0"
set "NODE_ZIP=node-%NODE_VER%-win-x64.zip"
set "NODE_URL=https://nodejs.org/dist/%NODE_VER%/%NODE_ZIP%"

call :banner

call :section "Setup - toolchain"
call :ensure_node
if errorlevel 1 goto fail
call :ensure_pnpm
if errorlevel 1 goto fail
call :ok "Toolchain ready"

if not exist "%DIR%" mkdir "%DIR%"
cd /d "%DIR%"

call :section "Update - fetching server.js"
call :download "%RAW%/server.js" "server.js.new"
if errorlevel 1 (
    if not exist "server.js" (
        call :err "Could not download server.js"
        goto fail
    )
    call :warn "Offline - using existing server.js"
) else (
    move /y "server.js.new" "server.js" >nul
    call :ok "server.js up to date"
)

call :download "%RAW%/package.json" "package.json.new"
if errorlevel 1 (
    if not exist "node_modules\" (
        call :err "Could not download package.json"
        goto fail
    )
    goto start
)

set "NEED=0"
if not exist "node_modules\" set "NEED=1"
if not exist "package.json" set "NEED=1"
if "!NEED!"=="0" (
    fc /b "package.json" "package.json.new" >nul 2>nul
    if errorlevel 1 set "NEED=1"
)
if "!NEED!"=="0" (
    del "package.json.new" >nul 2>nul
    call :ok "Dependencies unchanged"
    goto start
)

move /y "package.json.new" "package.json" >nul
call :download "%RAW%/pnpm-lock.yaml" "pnpm-lock.yaml"
call :download "%RAW%/pnpm-workspace.yaml" "pnpm-workspace.yaml"
call :section "Dependencies - pnpm install --prod"
call pnpm install --prod
if errorlevel 1 (
    call :err "Failed to install dependencies."
    goto fail
)
call :ok "Dependencies installed."

:start
call :section "Start - node server.js"
node server.js
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
echo   !C_CYAN!                             ^|___./ !C_RESET!
echo   !C_GRAY!  ZeroKey - local AI proxy!C_RESET!
echo.
exit /b

:section
echo.
echo !C_BOLD!!C_CYAN![ %~1 ]!C_RESET!
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

:fail
echo.
call :err "Setup failed. See errors above."
pause
exit /b 1

:: -- Ensure Node.js + npm (system PATH or %TOOLS%\node) --
:ensure_node
where node >nul 2>nul
if not errorlevel 1 (
    where npm >nul 2>nul
    if not errorlevel 1 exit /b 0
)
if exist "%TOOLS%\node\node.exe" (
    set "PATH=%TOOLS%\node;%PATH%"
    exit /b 0
)
call :section "Node.js - portable install"
call :warn "Node.js not found. Downloading portable Node.js %NODE_VER%..."
if not exist "%TOOLS%" mkdir "%TOOLS%"
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
call :ok "Node.js + npm ready."
exit /b 0

:: -- Ensure pnpm --
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

:: -- Download a URL to a file using curl --
:download
where curl >nul 2>nul
if errorlevel 1 (
    call :err "curl is not available. Windows 10 1803+ is required."
    exit /b 1
)
curl -fsSL --retry 3 -o "%~2" "%~1"
exit /b %errorlevel%
