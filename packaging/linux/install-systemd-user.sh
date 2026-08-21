#!/bin/sh
set -eu

package_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_root="$HOME/.local/lib/turnfold"
data_root="$HOME/.local/share/turnfold"
unit_root="$HOME/.config/systemd/user"

test -x "$package_root/turnfold"
test -f "$package_root/dist/index.html"
systemctl --user stop turnfold.service 2>/dev/null || true
install -d -m 0755 "$install_root" "$unit_root"
install -d -m 0700 "$data_root"
install -m 0755 "$package_root/turnfold" "$install_root/turnfold"

staged_dist="$install_root/dist.new.$$"
trap 'rm -rf "$staged_dist"' EXIT HUP INT TERM
mkdir -m 0755 "$staged_dist"
cp -R "$package_root/dist/." "$staged_dist/"
rm -rf "$install_root/dist"
mv "$staged_dist" "$install_root/dist"
trap - EXIT HUP INT TERM

install -m 0644 "$package_root/service/turnfold.service" "$unit_root/turnfold.service"
systemctl --user daemon-reload
systemctl --user enable --now turnfold.service

echo "Turnfold was installed and started at http://127.0.0.1:3000/."
echo "Database: $data_root/turnfold.db"
echo "Vault keyring entry: default"
