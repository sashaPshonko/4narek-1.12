#!/bin/bash

# Обновление системы
apt-get update
apt-get upgrade -y

# Установка curl
apt-get install -y curl
curl -fsSL https://deb.nodesource.com/setup_23.x | bash -
apt-get install -y nodejs

# Проверка версии
node --version
npm --version

echo "Node.js установлен!"
apt install git -y
git clone https://github.com/sashaPshonko/4narek-1.12
cd 4narek-1.12
nohup bash scripts/504.sh > bot.log 2>&1 &
git pull
chmod +x xray.sh xray-check.sh
sudo bash xray.sh

nohup bash scripts/run/sellbot.sh > sellbot.log 2>&1 &
nohup bash scripts/run/sell.sh > sell.log 2>&1 &


** Чтобы ваш Аккаунт был в БЕЗОПАСНОСТИ!