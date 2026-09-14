#!/usr/bin/env bash
set -e

REPO_URL="https://github.com/downloaddoctor/zerokey.git"
BRANCH="main"
DIR="$(cd "$(dirname "$0")" && pwd)/zerokey"
TOOLS="$(cd "$(dirname "$0")" && pwd)/.zerokey-tools"
HR="----------------------------------------"

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
    echo "  ${C_CYAN}  / // _ \\ '__/ _ \\| ' // _ \\ | | |${C_RESET}"
    echo "  ${C_CYAN} / /|  __/ | | (_) | . \\  __/ |_| |${C_RESET}"
    echo "  ${C_CYAN}/____\\___|_|  \\___/|_|\\_\\___|\\__, |${C_RESET}"
    echo "  ${C_CYAN}                            |___/ ${C_RESET}"
    echo "  ${C_GRAY}  ZeroKey - local AI proxy${C_RESET}"
    echo ""
}

section() { echo ""; echo "${C_BOLD}${C_CYAN}[ $1 ]${C_RESET}"; }
hr()      { echo "${C_GRAY}${HR}${C_RESET}"; }
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

# -- Ensure git --
ensure_git() {
    if command -v git >/dev/null 2>&1; then return 0; fi
    section "Git - install"
    warn "git not found. Installing via package manager..."
    if ! pkg_install git; then
        err "Could not install git. Install it manually and re-run."
        exit 1
    fi
    ok "Git ready."
}

# -- Ensure Node.js + npm --
ensure_node() {
    if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
        return 0
    fi
    section "Node.js - install"
    warn "Node.js/npm not found. Installing via package manager..."
    if ! pkg_install nodejs npm; then
        err "Could not install Node.js. Install it manually and re-run."
        exit 1
    fi
    if ! command -v node >/dev/null 2>&1; then
        err "node still not runnable. Check your installation."
        exit 1
    fi
    if ! command -v npm >/dev/null 2>&1; then
        err "npm still not runnable. Check your installation."
        exit 1
    fi
    ok "Node.js + npm ready."
}

# -- Ensure pnpm --
ensure_pnpm() {
    if command -v pnpm >/dev/null 2>&1; then return 0; fi
    section "pnpm - install"
    warn "pnpm not found. Installing via npm..."
    if ! npm install -g pnpm; then
        warn "Global npm install failed. Trying corepack..."
        if command -v corepack >/dev/null 2>&1; then
            corepack enable && corepack prepare pnpm@latest --activate || true
        fi
    fi
    if ! command -v pnpm >/dev/null 2>&1; then
        err "pnpm still not runnable."
        exit 1
    fi
    ok "pnpm ready."
}

install_deps() {
    section "Dependencies - pnpm install --prod"
    if ! pnpm install --prod; then
        err "Failed to install dependencies."
        exit 1
    fi
    ok "Dependencies installed."
}

start_server() {
    section "Start - node server.js"
    node server.js
}

# -- Flow --
banner

section "Setup - toolchain"
ensure_git
ensure_node
ensure_pnpm
ok "Toolchain ready"

# -- Step 1: Clone if not already cloned --
if [ ! -d "$DIR/.git" ]; then
    section "Clone - fetching ZeroKey"
    warn "ZeroKey not found. Cloning $REPO_URL ..."
    if ! git clone --progress "$REPO_URL" "$DIR"; then
        err "Failed to clone. Check your network."
        exit 1
    fi
    ok "Cloned to $DIR"
    cd "$DIR"
    install_deps
    start_server
    exit 0
fi

# -- Step 2: Already cloned --
cd "$DIR"

if [ ! -d "node_modules" ]; then
    install_deps
    start_server
    exit 0
fi

# -- Step 3: Check for updates --
section "Updates - checking origin/$BRANCH"
warn "Fetching remote..."

if ! git fetch origin 2>/dev/null; then
    warn "Could not check for updates (no network?)"
    start_server
    exit 0
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")

if [ -z "$REMOTE" ]; then
    warn "Could not reach remote - skipping."
    start_server
    exit 0
fi

if [ "$LOCAL" = "$REMOTE" ]; then
    ok "Already up to date."
    start_server
    exit 0
fi

echo ""
echo "${C_BOLD}${C_YELLOW}[ UPDATE AVAILABLE ]${C_RESET}"
echo "${C_GRAY}local:  ${C_DIM}${LOCAL:0:8}${C_RESET}"
echo "${C_GRAY}remote: ${C_DIM}${REMOTE:0:8}${C_RESET}"
echo ""
read -rp "  Update now? (y/N): " DOUPDATE
if [ "$DOUPDATE" = "y" ] || [ "$DOUPDATE" = "Y" ]; then
    section "Pull - fast-forward origin/$BRANCH"
    git fetch origin "$BRANCH"
    if ! git pull origin "$BRANCH" --ff-only; then
        warn "Fast-forward failed - local history diverged."
        warn "Resetting local repo to match origin/$BRANCH (local changes discarded)."
        git reset --hard "origin/$BRANCH"
    fi
    ok "Repo updated."
    install_deps
fi

start_server
