#!/bin/bash
# Запуск оркестратора с внешним watchdog.
# Busy-loop в node (~100% CPU) не крутит JS-таймеры — только снаружи по mtime лога.
set -euo pipefail

NAME="${1:?usage: run-orch.sh 502}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

if [ -f .gui-desk.env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.gui-desk.env
    set +a
fi

mkdir -p logs
LOG="logs/${NAME}.log"
# тишина дольше → SIGTERM, ещё 20с → SIGKILL (как зависание 503/504/506 ~15:44)
MAX_SILENCE_SEC="${ORCH_WATCHDOG_SEC:-360}"
CHECK_EVERY_SEC=20

exec >>"$LOG" 2>&1

echo "[watchdog] ${NAME} start max_silence=${MAX_SILENCE_SEC}s"

while true; do
    node "${NAME}b.mjs" &
    pid=$!
    echo "[watchdog] ${NAME} pid=$pid"

    while kill -0 "$pid" 2>/dev/null; do
        sleep "$CHECK_EVERY_SEC"
        if ! kill -0 "$pid" 2>/dev/null; then
            break
        fi
        if [ ! -f "$LOG" ]; then
            continue
        fi
        now=$(date +%s)
        mtime=$(stat -c %Y "$LOG" 2>/dev/null || echo "$now")
        age=$((now - mtime))
        if [ "$age" -ge "$MAX_SILENCE_SEC" ]; then
            echo "[watchdog] ${NAME} log silent ${age}s (≥${MAX_SILENCE_SEC}) → kill $pid"
            kill -TERM "$pid" 2>/dev/null || true
            for _ in 1 2 3 4 5 6 7 8 9 10; do
                kill -0 "$pid" 2>/dev/null || break
                sleep 2
            done
            if kill -0 "$pid" 2>/dev/null; then
                echo "[watchdog] ${NAME} still alive → SIGKILL $pid"
                kill -KILL "$pid" 2>/dev/null || true
            fi
            wait "$pid" 2>/dev/null || true
            break
        fi
    done

    wait "$pid" 2>/dev/null || true
    echo "[watchdog] ${NAME} exited, restart in 5s"
    sleep 5
done
