#!/bin/sh
set -eu

if [ -n "${KEY_VAULT_TOKEN_FILE:-}" ] && [ -f "$KEY_VAULT_TOKEN_FILE" ]; then
  install -m 0400 -o bun -g bun "$KEY_VAULT_TOKEN_FILE" /tmp/key_vault_service_token
  export KEY_VAULT_TOKEN_FILE=/tmp/key_vault_service_token
fi
install -d -m 0700 -o bun -g bun /data
exec su bun -s /bin/sh -c 'exec bun src/server.ts'
