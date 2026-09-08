#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
if [ -f .gui-desk.env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.gui-desk.env
    set +a
fi
mkdir -p logs
exec >>logs/503.log 2>&1
while true; do
    node 503b.mjs
    sleep 5
done
