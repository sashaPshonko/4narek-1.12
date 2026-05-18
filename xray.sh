#!/bin/bash

set -e

# Ваша vless-ссылка (та же, что вы дали)
VLESS_URL="vless://3eeb89a5-ce22-468a-bc31-048e2494cabf@213.139.229.143:25987?encryption=none&security=reality&type=tcp&sni=images-na.ssl-images-amazon.com&fp=chrome&pbk=8n3UBOAtlSfS7gil_ym5yPiBRZNQTMxMOSkbptogChc&sid=6ba85179e30d4fc2&flow=xtls-rprx-vision#Latvia_Reality"

# Парсим параметры из ссылки (без внешних зависимостей, только bash + sed/grep)
ID=$(echo "$VLESS_URL" | grep -oP '(?<=vless://)[^@]+' | cut -d'@' -f1)
ADDR=$(echo "$VLESS_URL" | grep -oP '[^@]+@\K[^:]+' | cut -d':' -f1)
PORT=$(echo "$VLESS_URL" | grep -oP ':\K\d+(?=\?)')
SNI=$(echo "$VLESS_URL" | grep -oP 'sni=\K[^&]+')
FP=$(echo "$VLESS_URL" | grep -oP 'fp=\K[^&]+')
PBK=$(echo "$VLESS_URL" | grep -oP 'pbk=\K[^&]+')
SID=$(echo "$VLESS_URL" | grep -oP 'sid=\K[^&]+')
FLOW=$(echo "$VLESS_URL" | grep -oP 'flow=\K[^&]+')

# Создаём папку для Xray
sudo mkdir -p /opt/xray
cd /opt/xray

# Скачиваем Xray (Linux amd64)
echo "📥 Скачиваем Xray..."
sudo wget -q --show-progress https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip
sudo apt update && sudo apt install unzip -y
sudo unzip -o Xray-linux-64.zip
sudo chmod +x xray

# Создаём config.json
echo "⚙️ Создаём config.json..."
sudo tee /opt/xray/config.json > /dev/null <<EOF
{
  "inbounds": [{
    "listen": "127.0.0.1",
    "port": 1080,
    "protocol": "socks",
    "settings": { "auth": "no", "udp": true }
  }],
  "outbounds": [{
    "protocol": "vless",
    "settings": {
      "vnext": [{
        "address": "$ADDR",
        "port": $PORT,
        "users": [{
          "id": "$ID",
          "encryption": "none",
          "flow": "$FLOW"
        }]
      }]
    },
    "streamSettings": {
      "network": "tcp",
      "security": "reality",
      "realitySettings": {
        "fingerprint": "$FP",
        "serverName": "$SNI",
        "publicKey": "$PBK",
        "shortId": "$SID"
      }
    }
  }]
}
EOF

# Останавливаем старый процесс, если был
if pgrep -x xray >/dev/null; then
    echo "🔄 Останавливаем старый xray..."
    sudo pkill -x xray || true
    sleep 1
fi

# Запускаем Xray в фоне
echo "🚀 Запускаем Xray..."
cd /opt/xray
sudo nohup /opt/xray/xray run -c /opt/xray/config.json >> /opt/xray/xray.log 2>&1 &

sleep 2
if ss -lnt | grep -q ':1080'; then
    echo "✅ Xray слушает 127.0.0.1:1080 (SOCKS5)"
    if curl -sf --max-time 10 -x socks5h://127.0.0.1:1080 -o /dev/null https://api.telegram.org; then
        echo "✅ Telegram API доступен через прокси"
    else
        echo "⚠️ Порт открыт, но Telegram не отвечает — смотри /opt/xray/xray.log"
    fi
else
    echo "⚠️ Порт 1080 не слушается. Лог: tail -50 /opt/xray/xray.log"
    exit 1
fi

echo "✅ Готово. Перезапусти оркестратор (502b / 509b …)"