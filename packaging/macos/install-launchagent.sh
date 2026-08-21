#!/bin/sh
set -eu

label="io.github.liooil.turnfold"
package_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_root="$HOME/Library/Application Support/Turnfold/runtime"
data_root="$HOME/Library/Application Support/Turnfold/data"
log_root="$HOME/Library/Logs/Turnfold"
agent_root="$HOME/Library/LaunchAgents"
agent="$agent_root/$label.plist"

test -x "$package_root/turnfold"
test -f "$package_root/dist/index.html"
/bin/launchctl bootout "gui/$UID/$label" 2>/dev/null || true
install -d -m 0755 "$install_root" "$agent_root" "$log_root"
install -d -m 0700 "$data_root"
install -m 0755 "$package_root/turnfold" "$install_root/turnfold"

staged_dist="$install_root/dist.new.$$"
trap 'rm -rf "$staged_dist"' EXIT HUP INT TERM
mkdir -m 0755 "$staged_dist"
cp -R "$package_root/dist/." "$staged_dist/"
rm -rf "$install_root/dist"
mv "$staged_dist" "$install_root/dist"
trap - EXIT HUP INT TERM

install -m 0644 "$package_root/service/io.github.liooil.turnfold.plist" "$agent"
/usr/bin/plutil -replace ProgramArguments.0 -string "$install_root/turnfold" "$agent"
/usr/bin/plutil -replace ProgramArguments.5 -string "$data_root/turnfold.db" "$agent"
/usr/bin/plutil -replace WorkingDirectory -string "$install_root" "$agent"
/usr/bin/plutil -replace StandardOutPath -string "$log_root/stdout.log" "$agent"
/usr/bin/plutil -replace StandardErrorPath -string "$log_root/stderr.log" "$agent"

/bin/launchctl bootstrap "gui/$UID" "$agent"
/bin/launchctl kickstart -k "gui/$UID/$label"

echo "Turnfold was installed and started at http://127.0.0.1:3000/."
echo "Database: $data_root/turnfold.db"
echo "Vault keyring entry: default"
