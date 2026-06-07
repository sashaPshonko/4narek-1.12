#!/bin/bash
set -euo pipefail

# VLESS — только в xray.local.env (не в git). /update не ломается.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/xray.local.env"
if [[ ! -f "$ENV_FILE" ]]; then
    echo "❌ Нет ${ENV_FILE}"
    echo "   cp xray.local.env.example xray.local.env  # и вставь VLESS_URL"
    exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"
if [[ -z "${VLESS_URL:-}" ]]; then
    echo "❌ VLESS_URL пуст в xray.local.env"
    exit 1
fi

parse_vless_param() {
    local key="$1"
    local query="${VLESS_URL#*\?}"
    query="${query%%#*}"
    echo "$query" | tr '&' '\n' | sed -n "s/^${key}=//p" | head -1
}

REST="${VLESS_URL#vless://}"
REST="${REST%%#*}"
ID="${REST%%@*}"
HOSTPART="${REST#*@}"
ADDR="${HOSTPART%%:*}"
PORT="${HOSTPART#*:}"
PORT="${PORT%%\?*}"

SECURITY="$(parse_vless_param security)"
SECURITY="${SECURITY:-reality}"
SNI=$(parse_vless_param sni)
FP=$(parse_vless_param fp)
PBK=$(parse_vless_param pbk)
SID=$(parse_vless_param sid)
FLOW=$(parse_vless_param flow)
NETWORK=$(parse_vless_param type)
NETWORK="${NETWORK:-tcp}"

echo "Параметры: server=${ADDR}:${PORT} security=${SECURITY} network=${NETWORK}"

for v in ID ADDR PORT; do
    if [[ -z "${!v}" ]]; then
        echo "❌ Пустой параметр: $v — проверь VLESS_URL"
        exit 1
    fi
done

if [[ "$SECURITY" == "reality" ]]; then
    for v in SNI FP PBK SID FLOW; do
        if [[ -z "${!v}" ]]; then
            echo "❌ Для Reality нужен параметр $v в VLESS_URL"
            exit 1
        fi
    done
fi

ARCH=$(uname -m)
case "$ARCH" in
    x86_64|amd64) XRAY_ZIP="Xray-linux-64.zip" ;;
    aarch64|arm64) XRAY_ZIP="Xray-linux-arm64-v8a.zip" ;;
    *)
        echo "❌ Неподдерживаемая архитектура: $ARCH"
        exit 1
        ;;
esac

sudo mkdir -p /opt/xray
cd /opt/xray

if [[ ! -x /opt/xray/xray ]]; then
    echo "📥 Скачиваем Xray ($XRAY_ZIP)..."
    sudo wget -q --show-progress "https://github.com/XTLS/Xray-core/releases/latest/download/${XRAY_ZIP}"
    if command -v apt-get >/dev/null; then
        sudo apt-get update -qq && sudo apt-get install -y unzip
    elif command -v yum >/dev/null; then
        sudo yum install -y unzip
    fi
    sudo unzip -o "$XRAY_ZIP"
    sudo chmod +x xray
    sudo rm -f "$XRAY_ZIP"
fi

if [[ "$SECURITY" == "reality" ]]; then
    USER_JSON="{
          \"id\": \"$ID\",
          \"encryption\": \"none\",
          \"flow\": \"$FLOW\"
        }"
    STREAM_JSON="{
      \"network\": \"$NETWORK\",
      \"security\": \"reality\",
      \"realitySettings\": {
        \"fingerprint\": \"$FP\",
        \"serverName\": \"$SNI\",
        \"publicKey\": \"$PBK\",
        \"shortId\": \"$SID\"
      }
    }"
else
    USER_JSON="{
          \"id\": \"$ID\",
          \"encryption\": \"none\"
        }"
    STREAM_JSON="{
      \"network\": \"$NETWORK\",
      \"security\": \"none\"
    }"
fi

echo "⚙️ config.json..."
sudo tee /opt/xray/config.json > /dev/null <<EOF
{
  "log": { "loglevel": "warning" },
  "inbounds": [{
    "listen": "127.0.0.1",
    "port": 1080,
    "protocol": "socks",
    "settings": { "auth": "no", "udp": true },
    "tag": "socks-in"
  }],
  "outbounds": [{
    "protocol": "vless",
    "tag": "proxy",
    "settings": {
      "vnext": [{
        "address": "$ADDR",
        "port": $PORT,
        "users": [$USER_JSON]
      }]
    },
    "streamSettings": $STREAM_JSON
  }]
}
EOF

echo "🔍 Проверка конфига..."
if ! sudo /opt/xray/xray run -test -c /opt/xray/config.json 2>&1 | tee /tmp/xray-test.log; then
    echo "❌ Конфиг невалиден — см. выше"
    exit 1
fi

sudo pkill -x xray 2>/dev/null || true
sleep 1

echo "🚀 Запуск xray..."
sudo bash -c '/opt/xray/xray run -c /opt/xray/config.json >> /opt/xray/xray.log 2>&1 &'
sleep 2

if ss -lnt 2>/dev/null | grep -q ':1080' || netstat -lnt 2>/dev/null | grep -q ':1080'; then
    echo "✅ Порт 1080 слушается"
    if curl -sf --max-time 15 -x socks5h://127.0.0.1:1080 -o /dev/null https://api.telegram.org; then
        echo "✅ Telegram API через прокси OK"
    else
        echo "⚠️ SOCKS есть, Telegram не ответил — tail /opt/xray/xray.log"
    fi
else
    echo "❌ Порт 1080 не поднялся. Последние строки лога:"
    sudo tail -40 /opt/xray/xray.log 2>/dev/null || echo "(лог пуст)"
    exit 1
fi

echo -n "$VLESS_URL" > "${SCRIPT_DIR}/.vless-applied.stamp"
chmod 644 "${SCRIPT_DIR}/.vless-applied.stamp"

echo "✅ Готово. Перезапусти оркестратор (502b.mjs / 510b.mjs …) или дождись автоперезапуска xray."
