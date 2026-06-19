#!/bin/bash
# Обёртка для Linux/VPS — внутри кроссплатформенный xray.mjs
set -euo pipefail
cd "$(dirname "$0")"
exec node xray.mjs "$@"
