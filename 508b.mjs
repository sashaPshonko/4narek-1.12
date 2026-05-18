import { Worker } from 'worker_threads';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import TelegramBot from 'node-telegram-bot-api';
import WebSocket from 'ws';
import { exec } from 'child_process';
import { buildTelegramBotOptions, attachTelegramDiagnostics, ensureTelegramProxy } from './telegram-proxy.mjs';
import {
    resolveGoType,
    applyPricesToBots,
    clearBotPresence,
    collectFleetTypes,
    buildPresencePayload,
} from './orchestrator-shared.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ========== КОНСТАНТЫ ==========
const botsPath = join(__dirname, './bots/508b.json');
const token = '7590462636:AAHmzPTD5kOVTgoQAwEh8mcFN6JaOr1_XsY';
const alertChatID = -1003827870631;
const WEBSOCKET_URL = 'ws://85.198.86.42:8080/ws';

// ========== ГЛОБАЛЬНЫЕ СОСТОЯНИЯ ==========
let catalog = [];
let lastPrices = {};
let bots = new Map(); // Map<username, botConfig>
let workers = new Map(); // Map<username, { worker, timeoutId }>
let botItems = new Map();
let botInventory = new Map();
let itemsBuying = [];
let socket;
let isSocketOpen = false;
let botsStarted = false;
let tgBot;
let isShuttingDown = false;

// ========== ФУНКЦИЯ ОТПРАВКИ АЛЕРТОВ ==========
async function sendAlert(message) {
    try {
        if (tgBot && !isShuttingDown) {
            await tgBot.sendMessage(alertChatID, message);
        }
        console.log(`🔔 ${message}`);
    } catch (error) {
        console.error('❌ Не удалось отправить алерт:', error.message);
    }
}

// ========== ЗАГРУЗКА КОНФИГОВ ==========
async function loadBotsConfig() {
    try {
        if (!existsSync(botsPath)) {
            await sendAlert(`❌ Файл ${botsPath} не найден`);
            process.exit(1);
        }
        
        const botsJson = await readFile(botsPath, 'utf-8');
        let loadedBots;
        try {
            loadedBots = JSON.parse(botsJson);
        } catch (e) {
            await sendAlert(`❌ Ошибка парсинга ${botsPath}: ${e.message}`);
            process.exit(1);
        }
        
        if (!Array.isArray(loadedBots)) {
            await sendAlert(`❌ ${botsPath} должен содержать массив`);
            process.exit(1);
        }
        
        bots.clear();
        for (const bot of loadedBots) {
            const goType = resolveGoType(bot);
            if (!goType) {
                console.warn(`⚠️ ${bot.username}: нет goType (добавь goType или item в bots.json)`);
            }
            bots.set(bot.username, {
                ...bot,
                goType,
                itemPrices: [],
                msgID: 0,
                msgTime: null,
                isManualStop: false,
                success: false
            });
        }
        
        console.log(`✅ bots.json загружен (${bots.size} ботов)`);
    } catch (error) {
        await sendAlert(`❌ Ошибка загрузки ${botsPath}: ${error.message}`);
        process.exit(1);
    }
}

// ========== РАБОТА С ВОРКЕРАМИ ==========
function safePostMessage(username, message) {
    const workerData = workers.get(username);
    if (!workerData || !workerData.worker) return false;
    
    try {
        if (!workerData.worker.terminated) {
            workerData.worker.postMessage(message);
            return true;
        }
    } catch (error) {
        // Игнорируем
    }
    return false;
}

async function runWorker(bot) {
    const username = bot.username;
    
    // Убиваем старый воркер если есть
    const existing = workers.get(username);
    if (existing) {
        if (existing.timeoutId) clearTimeout(existing.timeoutId);
        try { existing.worker.terminate(); } catch (e) {}
        workers.delete(username);
    }

    return new Promise((resolve) => {
        try {
            const workerScriptPath = join(__dirname, `${bot.type}.mjs`);
            
            if (!existsSync(workerScriptPath)) {
                console.error(`❌ Файл воркера не найден: ${workerScriptPath}`);
                resolve(null);
                return;
            }
            
            const worker = new Worker(workerScriptPath, {
                workerData: bot,
                resourceLimits: {
                    maxOldGenerationSizeMb: 200,
                }
            });

            bot.isManualStop = false;
            
            const timeoutId = setTimeout(() => {
                if (!bot.success) {
                    console.warn(`⏱ ${username} не ответил за 30 сек`);
                    try { worker.terminate(); } catch (e) {}
                }
            }, 30000);
            
            workers.set(username, { worker, timeoutId });

            worker.on('message', async (message) => {
                try {
                    if (message.name === 'success') {
                        const botToUpdate = bots.get(username);
                        if (botToUpdate) {
                            botToUpdate.success = true;
                            console.log(`✅ ${username} запущен`);
                            pushPresenceToGo();
                        }
                    } else if (message.name === "buy" || message.name === "sell" || message.name === "try-sell") {
                        if (socket && isSocketOpen) {
                            const action = message.name === 'try-sell' ? 'try-sell' : message.name;
                            const payload = { action, type: message.id };
                            if (message.price) payload.price = message.price;
                            socket.send(JSON.stringify(payload));
                        }
                    } else if (message.name === "items") {
                        botItems.set(username, message.items);
                    } else if (message.name === "inventory") {
                        botInventory.set(username, message.data);
                    } else if (message.name === "buying") {
                        const updatedBuying = [...itemsBuying, message.data];
                        for (const [user, _] of workers) {
                            safePostMessage(user, { type: 'items_buying', data: updatedBuying });
                        }
                        itemsBuying = updatedBuying;
                        if (socket && isSocketOpen) {
                            socket.send(JSON.stringify({ action: "add", json_data: message.data }));
                        }
                    } else if (message.name === "set_min_price" || message.name === "set_max_price") {
                        if (socket && isSocketOpen) {
                            socket.send(JSON.stringify({ 
                                action: message.name === "set_min_price" ? 'set_min_price' : 'set_max_price', 
                                type: message.type, 
                                price: message.price 
                            }));
                        }
                    } else if (typeof message === 'string') {
                        // Любая строка от воркера отправляется в Telegram
                        await sendAlert(`📝 ${message}`);
                    }
                } catch (error) {
                    await sendAlert(`❌ Ошибка в обработчике ${username}: ${error.message}`);
                }
            });

            worker.on('error', async (error) => {
                bot.success = false;
                clearBotPresence(username, botItems, botInventory);
                pushPresenceToGo();
                await sendAlert(error.message)
            });

            worker.on('exit', (code) => {
                bot.success = false;
                clearBotPresence(username, botItems, botInventory);
                pushPresenceToGo();
                console.warn(`⚠️ ${username} завершился с кодом ${code}`);
                
                const workerData = workers.get(username);
                if (workerData && workerData.timeoutId) {
                    clearTimeout(workerData.timeoutId);
                }
                workers.delete(username);
                
                if (!bot.isManualStop && !isShuttingDown) {
                    setTimeout(() => {
                        console.log(`🔁 Перезапуск ${username}`);
                        runWorker(bot);
                    }, 10000);
                }
            });

            resolve(worker);
        } catch (error) {
            console.error(`❌ Ошибка запуска ${username}:`, error.message);
            resolve(null);
        }
    });
}

async function stopWorkers() {
    for (const bot of bots.values()) {
        bot.isManualStop = true;
    }
    
    for (const username of [...workers.keys()]) {
        clearBotPresence(username, botItems, botInventory);
    }
    for (const { worker } of workers.values()) {
        try { worker.terminate(); } catch (e) {}
    }
    workers.clear();
    pushPresenceToGo();
    console.log('✅ Все боты остановлены');
}

function handleServerPriceMessage(dataObj) {
    if (Array.isArray(dataObj.catalog) && dataObj.catalog.length > 0) {
        catalog = dataObj.catalog;
        console.log(`✅ каталог с Go (${catalog.length} предметов)`);
    }
    if (!dataObj.prices) return;

    lastPrices = dataObj.prices;
    const { anyItems } = applyPricesToBots({
        catalog,
        prices: lastPrices,
        bots,
        workers,
        safePostMessage,
    });

    if (!botsStarted && catalog.length > 0 && anyItems) {
        botsStarted = true;
        startBots();
    }
}

async function startBots() {
    try {
        await loadBotsConfig();

        if (catalog.length === 0) {
            console.log('⏳ ждём каталог от Go-server…');
            if (socket && isSocketOpen) {
                socket.send(JSON.stringify({ action: 'info' }));
            }
            return;
        }

        applyPricesToBots({
            catalog,
            prices: lastPrices,
            bots,
            workers,
            safePostMessage,
        });

        sendFleetToGo();

        for (const bot of bots.values()) {
            await runWorker(bot);
        }

        setTimeout(() => {
            if (socket && isSocketOpen) {
                socket.send(JSON.stringify({ action: 'info' }));
            }
        }, 1000);
    } catch (error) {
        await sendAlert(`❌ Ошибка запуска ботов: ${error.message}`);
    }
}

async function restartBots() {
    console.log('🔄 Перезапуск...');
    await stopWorkers();
    await startBots();
}

// ========== TELEGRAM КОМАНДЫ ==========
async function initTelegram() {
    await ensureTelegramProxy();
    tgBot = new TelegramBot(token, buildTelegramBotOptions());
    attachTelegramDiagnostics(tgBot);

    try {
        await tgBot.sendMessage(alertChatID, '✅ Оркестратор 508 запущен');
    } catch (error) {
        console.error('[Telegram] не удалось отправить стартовое сообщение:', error.message);
    }

    tgBot.onText(/\/update/, async (msg) => {
        if ((Date.now() / 1000) - msg.date > 10) return;
        await tgBot.sendMessage(alertChatID, '🔄 Обновление, перезапуск...');
        isShuttingDown = true;
        exec('git pull', async (err, stdout) => {
            if (err) {
                await sendAlert(`❌ Git pull error: ${err.message}`);
            } else {
                console.log('Git pull выполнен:', stdout);
            }
            process.exit(0);
        });
    });
    
    tgBot.onText(/\/ping/, async (msg) => {
        if ((Date.now() / 1000) - msg.date > 10) return;
        await tgBot.sendMessage(alertChatID, `✅ Работает (ботов: ${workers.size})`);
    });
    
    tgBot.onText(/\/start/, async (msg) => {
        if ((Date.now() / 1000) - msg.date > 10) return;
        await tgBot.sendMessage(alertChatID, '🔄 Запуск ботов');
        await startBots();
    });
    
    tgBot.onText(/\/stop/, async (msg) => {
        if ((Date.now() / 1000) - msg.date > 10) return;
        await tgBot.sendMessage(alertChatID, '⏹ Остановка');
        await stopWorkers();
    });
    
    tgBot.onText(/\/reload/, async (msg) => {
        if ((Date.now() / 1000) - msg.date > 10) return;
        await tgBot.sendMessage(alertChatID, '🔄 Перезагрузка конфигов, перезапуск...');
        isShuttingDown = true;
        process.exit(0);
    });
    
    console.log('✅ Telegram бот готов');
}

function sendFleetToGo() {
    if (!socket || !isSocketOpen) return;
    const types = collectFleetTypes(bots);
    socket.send(JSON.stringify({ action: 'fleet', types }));
    console.log(`[FLEET] → Go: ${types.length ? types.join(', ') : 'пусто'}`);
}

function pushPresenceToGo() {
    if (!socket || !isSocketOpen) return;
    socket.send(JSON.stringify(buildPresencePayload(bots, workers, botItems, botInventory)));
}

// ========== WEBSOCKET ==========
function connectWebSocket() {
    if (socket) {
        try { socket.close(); } catch (e) {}
    }
    
    try {
        socket = new WebSocket(WEBSOCKET_URL);

        socket.on('open', () => {
            console.log('✅ WebSocket подключен');
            isSocketOpen = true;
            sendFleetToGo();
            socket.send(JSON.stringify({ action: 'info' }));
        });

        socket.on('message', async (data) => {
            try {
                const dataObj = JSON.parse(data);
                
                if (dataObj.action === "json_update" && Array.isArray(dataObj.data)) {
                    for (const [username, _] of workers) {
                        safePostMessage(username, { type: 'items_buying', data: dataObj.data });
                    }
                    itemsBuying = dataObj.data;
                } else if (dataObj.prices) {
                    handleServerPriceMessage(dataObj);
                }
            } catch (e) {
                await sendAlert(`❌ Ошибка обработки WebSocket сообщения: ${e.message}`);
            }
        });

        socket.on('close', () => {
            console.log('❌ WebSocket отключен');
            isSocketOpen = false;
            setTimeout(connectWebSocket, 5000);
        });

        socket.on('error', async (err) => {
            await sendAlert(`❌ WebSocket error: ${err.message}`);
        });
    } catch (error) {
        sendAlert(`❌ WebSocket connection error: ${error.message}`);
        setTimeout(connectWebSocket, 5000);
    }
}

// ========== МОНИТОРИНГ ==========
setInterval(() => {
    try {
        if (socket && isSocketOpen) {
            pushPresenceToGo();
        }
    } catch (error) {
        console.error('Presence error:', error.message);
    }
}, 30000);

// Очистка лога раз в 5 часов
setInterval(async () => {
    try {
        exec('> bot.log', (err) => {
            if (err) console.error('Clean log error:', err.message);
        });
    } catch (error) {}
}, 5 * 60 * 60 * 1000);

// ========== ГЛОБАЛЬНЫЕ ОБРАБОТЧИКИ ==========
process.on('unhandledRejection', async (reason) => {
    await sendAlert(`❌ Unhandled Rejection: ${reason?.message || reason}`);
});

process.on('uncaughtException', async (error) => {
    await sendAlert(`❌ Uncaught Exception: ${error.message}`);
    setTimeout(() => {
        if (!isShuttingDown) {
            process.exit(1);
        }
    }, 3000);
});

// ========== ЗАПУСК ==========
async function main() {
    await initTelegram();
    await loadBotsConfig();
    connectWebSocket();
}

main().catch(async (error) => {
    await sendAlert(`❌ Критическая ошибка при запуске: ${error.message}`);
    process.exit(1);
});