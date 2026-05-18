#!/bin/bash
# Быстрая диагностика — запускай на VPS: bash xray-check.sh

echo "=== порт 1080 ==="
ss -lntp 2>/dev/null | grep 1080 || netstat -lntp 2>/dev/null | grep 1080 || echo "ничего не слушает"

echo "=== процесс xray ==="
pgrep -a xray || echo "xray не запущен"

echo "=== бинарник ==="
ls -la /opt/xray/xray 2>/dev/null || echo "нет /opt/xray/xray"

echo "=== тест конфига ==="
/opt/xray/xray run -test -c /opt/xray/config.json 2>&1 || true

echo "=== последние 40 строк лога ==="
tail -40 /opt/xray/xray.log 2>/dev/null || echo "лог пуст"

echo "=== до Латвии (порт из config) ==="
PORT=$(grep -o '"port": [0-9]*' /opt/xray/config.json | head -1 | grep -o '[0-9]*')
ADDR=$(grep '"address"' /opt/xray/config.json | head -1 | sed 's/.*"\([^"]*\)".*/\1/')
echo "ping $ADDR:$PORT"
timeout 5 bash -c "echo >/dev/tcp/${ADDR}/${PORT}" 2>/dev/null && echo OK || echo "не достучались"

echo "=== curl через SOCKS ==="
curl -s -o /dev/null -w "http_code=%{http_code}\n" --max-time 10 -x socks5h://127.0.0.1:1080 https://api.telegram.org || echo "curl failed"
