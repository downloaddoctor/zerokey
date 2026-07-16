#!/usr/bin/env bash
set -e

REPO_URL="https://github.com/downloaddoctor/zerokey.git"
BRANCH="main"
DIR="$(cd "$(dirname "$0")" && pwd)/zerokey"
HR="----------------------------------------"

hr() { echo "$HR"; }

install_deps() {
    echo ""
    echo "Installing dependencies..."
    hr
    if ! pnpm install; then
        echo "Failed to install dependencies. Is pnpm installed?"
        exit 1
    fi
    hr
}

start_server() {
    echo ""
    echo "Starting ZeroKey..."
    hr
    node server.js
}

echo "ZeroKey - Your local AI proxy"
echo "=============================="

# ── Step 1: Clone if not already cloned ──
if [ ! -d "$DIR/.git" ]; then
    echo ""
    echo "ZeroKey not found. Cloning..."
    hr
    git clone --progress "$REPO_URL" "$DIR"
    hr
    cd "$DIR"
    install_deps
    start_server
    exit 0
fi

# ── Step 2: Already cloned ──
cd "$DIR"

# Missing node_modules — reinstall
if [ ! -d "node_modules" ]; then
    install_deps
    start_server
    exit 0
fi

# ── Step 3: Check for updates ──
echo ""
echo "Checking for updates..."
hr

if ! git fetch origin 2>/dev/null; then
    echo "Could not check for updates (no network?)"
    start_server
    exit 0
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")

if [ -z "$REMOTE" ]; then
    echo "Could not reach remote — skipping."
    start_server
    exit 0
fi

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "Already up to date."
    hr
    start_server
    exit 0
fi

echo ""
echo "============================================"
echo " UPDATE AVAILABLE"
echo "============================================"
echo ""
read -rp "Update now? (y/n): " DOUPDATE
if [ "$DOUPDATE" = "y" ] || [ "$DOUPDATE" = "Y" ]; then
    echo ""
    echo "Pulling latest changes..."
    hr
    git pull origin "$BRANCH"
    hr
    install_deps
fi

start_server
