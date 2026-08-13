#!/bin/sh
set -eu

install -d -m 0700 -o bun -g bun /data
exec su bun -s /bin/sh -c 'exec bun src/server.ts'
