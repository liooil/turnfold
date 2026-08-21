#!/bin/sh
set -eu

label="io.github.liooil.turnfold"
agent="$HOME/Library/LaunchAgents/$label.plist"
/bin/launchctl bootout "gui/$UID/$label" 2>/dev/null || true
rm -f "$agent"

if [ "${1:-}" = "--remove-application" ]; then
    rm -rf "$HOME/Library/Application Support/Turnfold/runtime"
fi

echo "Turnfold LaunchAgent removed. Application files, database, and OS keyring entry were preserved by default."
