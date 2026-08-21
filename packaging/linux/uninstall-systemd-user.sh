#!/bin/sh
set -eu

unit="$HOME/.config/systemd/user/turnfold.service"
systemctl --user disable --now turnfold.service 2>/dev/null || true
rm -f "$unit"
systemctl --user daemon-reload

if [ "${1:-}" = "--remove-application" ]; then
    rm -rf "$HOME/.local/lib/turnfold"
fi

echo "Turnfold user service removed. Application files, database, and OS keyring entry were preserved by default."
