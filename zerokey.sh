#!/usr/bin/env bash
set -e

RAW="https://raw.githubusercontent.com/downloaddoctor/zerokey/dist"
DIR="$(cd "$(dirname "$0")" && pwd)/zerokey"

# -- Colors (only when stdout is a tty) --
if [ -t 1 ]; then
    C_RESET=$'\033[0m'
    C_DIM=$'\033[2m'
    C_BOLD=$'\033[1m'
    C_CYAN=$'\033[36m'
    C_GREEN=$'\033[32m'
    C_YELLOW=$'\033[33m'
    C_RED=$'\033[31m'
    C_GRAY=$'\033[90m'
else
    C_RESET=""; C_DIM=""; C_BOLD=""; C_CYAN=""
    C_GREEN=""; C_YELLOW=""; C_RED=""; C_GRAY=""
fi

# -- UI helpers --
banner() {
    echo ""
    echo "  ${C_CYAN} ______             _  __          ${C_RESET}"
    echo "  ${C_CYAN}|__  /___ _ __ ___ | |/ /___ _   _ ${C_RESET}"
    echo "  ${C_CYAN}  / // _ \ '__/ _ \| ' // _ \ | | |${C_RESET}"
    echo "  ${C_CYAN} / /|  __/ | | (_) | . \  __/ |_| |${C_RESET}"
    echo "  ${C_CYAN}/____\___|_|  \___/|_|\_\___|\__, |${C_RESET}"
    echo "  ${C_CYAN}                             |___./ ${C_RESET}"
    echo "  ${C_GRAY}  ZeroKey - local AI proxy${C_RESET}"
    echo ""
}

section() { echo ""; echo "${C_BOLD}${C_CYAN}[ $1 ]${C_RESET}"; }
ok()      { echo "${C_GREEN}[OK]${C_RESET} $1"; }
warn()    { echo "${C_YELLOW}[..]${C_RESET} $1"; }
err()     { echo "${C_RED}[XX]${C_RESET} $1"; }

# -- Detect package manager / sudo --
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    command -v sudo >/dev/null 2>&1 && SUDO="sudo"
fi

pkg_install() {
    if command -v apt-get >/dev/null 2>&1; then
        $SUDO apt-get update -y && $SUDO apt-get install -y "$@"
    elif command -v dnf >/dev/null 2>&1; then
        $SUDO dnf install -y "$@"
    elif command -v yum >/dev/null 2>&1; then
        $SUDO yum install -y "$@"
    elif command -v pacman >/dev/null 2>&1; then
        $SUDO pacman -Sy --noconfirm "$@"
    elif command -v apk >/dev/null 2>&1; then
        $SUDO apk add --no-cache "$@"
    elif command -v brew >/dev/null 2>&1; then
        brew install "$@"
    else
        return 1
    fi
}

banner

section "Setup - toolchain"
command -v curl >/dev/null 2>&1 || pkg_install curl

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    warn "Node.js not found. Installing via package manager..."
    pkg_install nodejs npm || { err "Install Node.js 22+ manually and re-run."; exit 1; }
fi

if ! command -v pnpm >/dev/null 2>&1; then
    warn "pnpm not found. Installing via npm..."
    npm install -g pnpm || { corepack enable && corepack prepare pnpm@latest --activate; }
fi
ok "Toolchain ready"

mkdir -p "$DIR"
cd "$DIR"

section "Update - fetching server.js"
if curl -fsSL --retry 3 -o server.js.new "$RAW/server.js"; then
    mv -f server.js.new server.js
    ok "server.js up to date"
elif [ -f server.js ]; then
    warn "Offline - using existing server.js"
else
    err "Could not download server.js"
    exit 1
fi

NEED=0
if curl -fsSL --retry 3 -o package.json.new "$RAW/package.json"; then
    if [ ! -d node_modules ] || [ ! -f package.json ] || ! cmp -s package.json package.json.new; then
        NEED=1
    fi
elif [ ! -d node_modules ]; then
    err "Could not download package.json"
    exit 1
fi

if [ "$NEED" = "1" ]; then
    mv -f package.json.new package.json
    curl -fsSL --retry 3 -o pnpm-lock.yaml "$RAW/pnpm-lock.yaml" || true
    curl -fsSL --retry 3 -o pnpm-workspace.yaml "$RAW/pnpm-workspace.yaml" || true
    section "Dependencies - pnpm install --prod"
    if ! pnpm install --prod; then
        err "Failed to install dependencies."
        exit 1
    fi
    ok "Dependencies installed."
else
    rm -f package.json.new
    ok "Dependencies unchanged"
fi

section "Start - node server.js"
exec node server.js
