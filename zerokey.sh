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

LOCAL=0
SELF="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$SELF/core/state/db.js" ]; then
    DIR="$SELF"
    LOCAL=1
fi
mkdir -p "$DIR"
cd "$DIR"

if [ "$LOCAL" = "1" ]; then
    ok "Local project detected, using its server.js"
    [ -d node_modules ] || pnpm install
    section "Start - node server.js"
    exec node server.js
fi

fetch() { curl -fsSL --retry 3 -o "$2" "$RAW/$1"; }

section "Update - checking"
UPDATE=0
ASK=0
if [ ! -f server.js ] || [ ! -d node_modules ]; then
    UPDATE=1
elif [ -f .update ]; then
    warn "Update available"
    ASK=1
elif ! fetch version.txt version.new; then
    rm -f version.new
    warn "Offline - using existing files"
elif cmp -s .version version.new; then
    rm -f version.new
    ok "Up to date"
else
    touch .update
    warn "Update available"
    ASK=1
fi

if [ "$ASK" = "1" ]; then
    rm -f version.new
    ans="y"
    if [ -t 0 ]; then
        printf "Update now? [Y/n] (10s) "
        read -r -t 10 ans || ans="y"
        echo ""
    fi
    case "${ans:-y}" in
        [Nn]*) warn "Keeping current version" ;;
        *) UPDATE=1 ;;
    esac
fi

if [ "$UPDATE" = "1" ]; then
    section "Update - downloading"
    if ! fetch version.txt version.new || ! fetch server.js server.js.new || ! fetch package.json package.json.new; then
        rm -f server.js.new package.json.new version.new
        if [ -f server.js ]; then
            warn "Update download failed - using existing files"
            UPDATE=0
        else
            err "Could not download server.js"
            exit 1
        fi
    fi
fi

if [ "$UPDATE" = "1" ]; then
    fetch pnpm-lock.yaml pnpm-lock.yaml.new || rm -f pnpm-lock.yaml.new
    fetch pnpm-workspace.yaml pnpm-workspace.yaml.new || rm -f pnpm-workspace.yaml.new
    NEED=0
    { [ -d node_modules ] && [ -f package.json ] && cmp -s package.json package.json.new; } || NEED=1
    mv -f server.js.new server.js
    mv -f package.json.new package.json
    if [ -f pnpm-lock.yaml.new ]; then mv -f pnpm-lock.yaml.new pnpm-lock.yaml; fi
    if [ -f pnpm-workspace.yaml.new ]; then mv -f pnpm-workspace.yaml.new pnpm-workspace.yaml; fi
    if [ "$NEED" = "1" ]; then
        section "Dependencies - pnpm install --prod"
        if ! pnpm install --prod; then
            err "Failed to install dependencies."
            exit 1
        fi
        ok "Dependencies installed."
    fi
    mv -f version.new .version
    rm -f .update
    ok "Update applied"
else
    rm -f version.new
fi

section "Start - node server.js"
exec node server.js
