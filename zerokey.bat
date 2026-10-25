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

set "RAW=https://github.com/downloaddoctor/zerokey/releases/latest/download"
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

if exist "%~dp0core\state\db.js" (set "DIR=%~dp0") else (if not exist "%DIR%" mkdir "%DIR%")
cd /d "%DIR%"

if exist "core\state\db.js" (
    call :ok "Local project detected, using its server.js"
    if not exist "node_modules\" call pnpm install
    goto start
)
call :section "Update - checking"
set "UPDATE=0"
if not exist "server.js" set "UPDATE=1"
if not exist "node_modules\" set "UPDATE=1"
if "!UPDATE!"=="1" goto doupdate
if exist ".update" (
    call :warn "Update available"
    goto askupdate
)
call :download "%RAW%/version.txt" "version.new"
if errorlevel 1 (
    del "version.new" >nul 2>nul
    call :warn "Offline - using existing files"
    goto start
)
fc /b ".version" "version.new" >nul 2>nul
if not errorlevel 1 (
    del "version.new" >nul 2>nul
    call :ok "Up to date"
    goto start
)
type nul > ".update"
call :warn "Update available"

:askupdate
del "version.new" >nul 2>nul
echo.
set "ANS="
set /p "ANS=!C_YELLOW![??]!C_RESET! Update now? [y/N] "
if /i "!ANS!"=="y" goto doupdate
call :warn "Keeping current version"
goto start

:doupdate
call :section "Update - downloading"
call :download "%RAW%/version.txt" "version.new"
if errorlevel 1 goto updfail
call :download "%RAW%/server.js" "server.js.new"
if errorlevel 1 goto updfail
call :download "%RAW%/package.json" "package.json.new"
if errorlevel 1 goto updfail
call :download "%RAW%/pnpm-lock.yaml" "pnpm-lock.yaml.new"
if errorlevel 1 del "pnpm-lock.yaml.new" >nul 2>nul
call :download "%RAW%/pnpm-workspace.yaml" "pnpm-workspace.yaml.new"
if errorlevel 1 del "pnpm-workspace.yaml.new" >nul 2>nul
call :download "%RAW%/SHA256SUMS" "SHA256SUMS.new"
if errorlevel 1 del "SHA256SUMS.new" >nul 2>nul
call :verify server.js
if errorlevel 1 goto updfail
call :verify package.json
if errorlevel 1 goto updfail
del "SHA256SUMS.new" >nul 2>nul

set "NEED=0"
if not exist "node_modules\" set "NEED=1"
if not exist "package.json" set "NEED=1"
if "!NEED!"=="0" (
    fc /b "package.json" "package.json.new" >nul 2>nul
    if errorlevel 1 set "NEED=1"
)
move /y "server.js.new" "server.js" >nul
move /y "package.json.new" "package.json" >nul
if exist "pnpm-lock.yaml.new" move /y "pnpm-lock.yaml.new" "pnpm-lock.yaml" >nul
if exist "pnpm-workspace.yaml.new" move /y "pnpm-workspace.yaml.new" "pnpm-workspace.yaml" >nul
if "!NEED!"=="1" (
    call :section "Dependencies - pnpm install --prod"
    call pnpm install --prod
    if errorlevel 1 (
        call :err "Failed to install dependencies."
        goto fail
    )
    call :ok "Dependencies installed."
)
move /y "version.new" ".version" >nul
del ".update" >nul 2>nul
call :ok "Update applied"

goto start

:updfail
del "server.js.new" "package.json.new" "pnpm-lock.yaml.new" "pnpm-workspace.yaml.new" "version.new" "SHA256SUMS.new" >nul 2>nul
if exist "server.js" (
    call :warn "Update download failed - using existing files"
    goto start
)
call :err "Could not download server.js"
goto fail

:start
call :section "Start - node server.js"
:: Ctrl+C means the user wants to close: leave on the same line as node so cmd never resumes the script (Y or N at the prompt both exit)
node server.js & endlocal & exit

:: -- Verify a downloaded <file>.new against SHA256SUMS.new (skipped when the sums file is absent) --
:verify
if not exist "SHA256SUMS.new" exit /b 0
set "WANT="
for /f "tokens=1" %%a in ('findstr /c:" %~1" "SHA256SUMS.new"') do set "WANT=%%a"
set "GOT="
for /f "delims=" %%h in ('certutil -hashfile "%~1.new" SHA256 ^| findstr /v ":"') do if not defined GOT set "GOT=%%h"
set "GOT=!GOT: =!"
if /i not "!WANT!"=="!GOT!" (
    call :err "Checksum mismatch for %~1"
    exit /b 1
)
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
