#!/bin/bash
#
# Start dev server in external terminal (Mac/Linux)
# Launches npm run dev in a new terminal that persists after Claude Code closes.
#

PORT=${1:-3000}

# Check if port is already in use
if lsof -i :$PORT > /dev/null 2>&1; then
    echo -e "\033[33mPort $PORT is already in use.\033[0m"
    echo -e "\033[32mExisting server detected - no action needed.\033[0m"

    # Show process info
    PID=$(lsof -t -i :$PORT 2>/dev/null | head -1)
    if [[ -n "$PID" ]]; then
        echo -e "\033[90mProcess ID: $PID\033[0m"
    fi
    exit 0
fi

PROJECT_DIR=$(pwd)

echo -e "\033[36mStarting dev server on port $PORT...\033[0m"

# Detect terminal and launch
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS - use Terminal.app or iTerm
    if [[ -d "/Applications/iTerm.app" ]]; then
        osascript -e "tell application \"iTerm\" to create window with default profile command \"cd '$PROJECT_DIR' && npm run dev\""
    else
        osascript -e "tell application \"Terminal\" to do script \"cd '$PROJECT_DIR' && npm run dev\""
    fi
elif command -v gnome-terminal &> /dev/null; then
    # Linux with GNOME
    gnome-terminal -- bash -c "cd '$PROJECT_DIR' && npm run dev; exec bash"
elif command -v xterm &> /dev/null; then
    # Fallback to xterm
    xterm -e "cd '$PROJECT_DIR' && npm run dev" &
else
    # Last resort - background process
    echo -e "\033[33mNo terminal emulator found. Running in background.\033[0m"
    cd "$PROJECT_DIR" && npm run dev &
    disown
fi

echo -e "\033[32mDev server starting in new terminal window.\033[0m"
echo -e "\033[90mURL: http://localhost:$PORT\033[0m"
