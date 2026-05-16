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

# Запускаем Xray в фоне (через nohup, лог в /opt/xray/xray.log)
echo "🚀 Запускаем Xray..."
sudo nohup /opt/xray/xray run > /opt/xray/xray.log 2>&1 &

# Проверяем, что порт открыт
sleep 2
if ss -lnt | grep -q ':1080'; then
    echo "✅ Xray запущен и слушает порт 1080 (SOCKS5)"
else
    echo "⚠️ Внимание: порт 1080 не прослушивается. Проверьте лог: /opt/xray/xray.log"
fi

echo "✅ Установка завершена. Теперь ваш бот может использовать socks5://127.0.0.1:1080"