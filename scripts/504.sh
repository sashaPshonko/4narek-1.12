#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
exec >>logs/504.log 2>&1
while true; do
    node 504b.mjs
    sleep 5
done
