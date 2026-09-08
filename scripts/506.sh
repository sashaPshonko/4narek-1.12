#!/bin/bash
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
exec >>logs/506.log 2>&1
while true; do
    node 506b.mjs
    sleep 5
done
