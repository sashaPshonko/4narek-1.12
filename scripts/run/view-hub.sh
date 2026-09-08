#!/bin/bash
cd "$(dirname "$0")/../.."
while true; do
    node lib/bot-view/hub.mjs
    sleep 3
done
