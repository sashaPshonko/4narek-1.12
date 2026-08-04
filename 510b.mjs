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
    tryAutoStartBots,
    shouldRestartWorkerOnExit,
    getWorkerRestartDelayMs,
    terminateWorkerEntry,
    createMarketFloorTracker,
    sendMarketFloorsToGo,
    getWorkerHealthStats,
    formatBotAlert,
    buildTelegramAlertText,
    formatOrchestratorPing,
    handleWorkerStatusMessage,
    handleFunauthGoMessage,
    applyWorkerBuyingClaim,
    buyingUuidForGo,
    applyGoJsonUpdate,
    runOrchestratorUpdate,
    resolveGoWebSocketUrl,
    ackWorkerReady,
    isWorkerReady,
    WORKER_READY_TIMEOUT_MS,
    createListingStore,
} from './orchestrator-shared.mjs';

const marketFloorTracker = createMarketFloorTracker({
    onFlush(floors, meta) {
        if (sendMarketFloorsToGo(socket, isSocketOpen, floors, meta)) {
            console.log('[AH floor] → Go:', floors, meta);
        }
    },
});
marketFloorTracker.start();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const listingStore = createListingStore(join(__dirname, 'listings-state'));

const LOCAL_MODE = true;
const SKIP_TELEGRAM = LOCAL_MODE;
if (LOCAL_MODE) {
    process.env.TELEGRAM_PROXY = 'off';
    process.env.TELEGRAM_AUTO_XRAY = 'off';
}

// ========== КОНСТАНТЫ ==========
const botsPath = join(__dirname, './bots/510b.json');
const token = '8722518852:AAGhgHQMBZqjNm__onmM_Ac-veB93BYMvNY';
const alertChatID = -1003827870631;
const WEBSOCKET_URL = resolveGoWebSocketUrl(LOCAL_MODE);

// ========== ГЛОБАЛЬНЫЕ СОСТОЯНИЯ ==========
let catalog = [];
let lastPrices = {};
let bots = new Map(); // Map<username, botConfig>
let workers = new Map();
const pendingRestarts = new Map();
let botItems = new Map();
let botInventory = new Map();
let itemsBuying = [];
let socket;
let isSocketOpen = false;
let tgBot;
let isShuttingDown = false;
let autoStartPending = false;
let startBotsRunning = false;

function workerStatusCtx() {
    return {
        bots, workers, pendingRestarts, botItems, botInventory, terminateWorkerEntry, pushPresenceToGo, sendAlert,
        sendToGo: (payload) => {
            if (!socket || !isSocketOpen) return false;
            socket.send(JSON.stringify(payload));
            return true;
        },
        runWorker,
    };
}

// ========== ФУНКЦИЯ ОТПРАВКИ АЛЕРТОВ ==========
async function sendAlert(message, botUsername = null) {
    const text = buildTelegramAlertText({ message, botUsername, bots });
    try {
        if (tgBot && !isShuttingDown) {
            await tgBot.sendMessage(alertChatID, text);
        }
        console.log(`🔔 ${text}`);
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
        
        const prevSuccess = new Map();
        for (const [name, b] of bots) {
            if (b.success) prevSuccess.set(name, true);
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
                success: prevSuccess.get(bot.username) ?? false,
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

    const pending = pendingRestarts.get(username);
    if (pending) {
        clearTimeout(pending);
        pendingRestarts.delete(username);
    }

    const existing = workers.get(username);
    if (existing) {
        await terminateWorkerEntry(existing);
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
                if (!isWorkerReady(bots, username)) {
                    console.warn(`⏱ ${username} не ответил за ${WORKER_READY_TIMEOUT_MS / 1000} сек`);
                    try { worker.terminate(); } catch (e) {}
                }
            }, WORKER_READY_TIMEOUT_MS);
            
            workers.set(username, { worker, timeoutId });

            worker.on('message', async (message) => {
                try {
                    if (message.name === 'success') {
                        if (ackWorkerReady(bots, workers, username)) {
                            console.log(`✅ ${username} запущен`);
                            pushPresenceToGo();
                        }
                    } else if (message.name === 'listing') {
                        const result = listingStore.handle(username, message);
                        safePostMessage(username, {
                            type: 'listing_res',
                            reqId: message.reqId,
                            result,
                        });
                    } else if (message.name === "buy" || message.name === "sell" || message.name === "try-sell") {
                        if (socket && isSocketOpen) {
                            const action = message.name === 'try-sell' ? 'try-sell' : message.name;
                            const payload = { action, type: message.id };
                            if (message.price) payload.price = message.price;
                            if (Array.isArray(message.enchants)) payload.enchants = message.enchants;
                            if (message.durability != null && Number.isFinite(Number(message.durability))) {
                                payload.durability = Number(message.durability);
                            }
                            socket.send(JSON.stringify(payload));
                        }
                    } else if (message.name === "items") {
                        botItems.set(username, message.items);
                    } else if (message.name === "inventory") {
                        botInventory.set(username, message.data);
                    } else if (message.name === "buying") {
                        const updatedBuying = applyWorkerBuyingClaim(itemsBuying, message, username);
                        for (const [user, _] of workers) {
                            safePostMessage(user, { type: 'items_buying', data: updatedBuying });
                        }
                        itemsBuying = updatedBuying;
                        const goUuid = buyingUuidForGo(message);
                        if (socket && isSocketOpen && goUuid) {
                            socket.send(JSON.stringify({ action: "add", json_data: goUuid }));
                        }
                    } else if (message.name === 'kicked') {
                        bot.lastKickReason = message.reason || '';
                    } else if (message.name === "set_min_price" || message.name === "set_max_price") {
                        if (socket && isSocketOpen) {
                            socket.send(JSON.stringify({ 
                                action: message.name === "set_min_price" ? 'set_min_price' : 'set_max_price', 
                                type: message.type, 
                                price: message.price 
                            }));
                        }
                    } else if (message.name === 'ah_market_floor') {
                        marketFloorTracker.mergeFromWorker(message);
                    } else if (message.name === 'clan_setup' || message.name === 'treasury_empty' || message.name === 'treasury_ok') {
                        await handleWorkerStatusMessage(message, username, workerStatusCtx());
                    } else if (typeof message === 'string') {
                        const handled = await handleWorkerStatusMessage(message, username, workerStatusCtx());
                        if (!handled && typeof message === 'string') {
                            await sendAlert(message, username);
                        }
                    }
                } catch (error) {
                    await sendAlert(`❌ Ошибка в обработчике ${username}: ${error.message}`, username);
                }
            });

            worker.on('error', async (error) => {
                bot.success = false;
                clearBotPresence(username, botItems, botInventory);
                pushPresenceToGo();
                await sendAlert(error.message, username)
            });

            worker.on('exit', (code) => {
                if (!shouldRestartWorkerOnExit(username, worker, workers)) {
                    return;
                }

                bot.success = false;
                clearBotPresence(username, botItems, botInventory);
                pushPresenceToGo();
                console.warn(`⚠️ ${username} завершился с кодом ${code}`);

                const workerData = workers.get(username);
                if (workerData?.timeoutId) clearTimeout(workerData.timeoutId);
                workers.delete(username);

                if (!bot.isManualStop && !isShuttingDown) {
                    const delayMs = getWorkerRestartDelayMs(code, bot.lastKickReason);
                    bot.lastKickReason = '';
                    const restartTimerId = setTimeout(() => {
                        pendingRestarts.delete(username);
                        console.log(`🔁 Перезапуск ${username} (через ${delayMs / 1000}с)`);
                        runWorker(bot);
                    }, delayMs);
                    pendingRestarts.set(username, restartTimerId);
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

    for (const timerId of pendingRestarts.values()) {
        clearTimeout(timerId);
    }
    pendingRestarts.clear();
    
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

function requestInfoFromGo() {
    if (socket && isSocketOpen) {
        socket.send(JSON.stringify({ action: 'info' }));
    }
}

function scheduleAutoStart(reason) {
    void tryAutoStartBots({
        reason,
        workers,
        isShuttingDown,
        catalog,
        prices: lastPrices,
        bots,
        safePostMessage,
        startBots,
        requestInfo: requestInfoFromGo,
        isPending: () => autoStartPending,
        setPending: (v) => { autoStartPending = v; },
        isStartBotsRunning: () => startBotsRunning,
    });
}

function handleServerPriceMessage(dataObj) {
    if (Array.isArray(dataObj.catalog) && dataObj.catalog.length > 0) {
        catalog = dataObj.catalog;
        console.log(`✅ каталог с Go (${catalog.length} предметов)`);
    }
    if (!dataObj.prices) return;

    lastPrices = dataObj.prices;
    applyPricesToBots({
        catalog,
        prices: lastPrices,
        bots,
        workers,
        safePostMessage,
    });

    scheduleAutoStart('ws-prices');
}

async function startBots() {
    if (startBotsRunning) return;
    startBotsRunning = true;
    try {
        await loadBotsConfig();

        if (catalog.length === 0) {
            console.log('ℹ️ каталог пуст (Go выкл / нет цен) — боты с пустым списком товаров');
            if (socket && isSocketOpen) {
                socket.send(JSON.stringify({ action: 'info' }));
            }
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
            if (bot.banned) continue;
            const live = workers.get(bot.username);
            if (live?.worker) continue;
            if (pendingRestarts.has(bot.username)) continue;
            await runWorker(bot);
        }

        setTimeout(() => {
            if (socket && isSocketOpen) {
                socket.send(JSON.stringify({ action: 'info' }));
            }
        }, 1000);
    } catch (error) {
        await sendAlert(`❌ Ошибка запуска ботов: ${error.message}`);
    } finally {
        startBotsRunning = false;
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
        await tgBot.sendMessage(alertChatID, '✅ Оркестратор 509 запущен');
    } catch (error) {
        console.error('[Telegram] не удалось отправить стартовое сообщение:', error.message);
    }

    tgBot.onText(/\/update/, async (msg) => {
        if ((Date.now() / 1000) - msg.date > 10) return;
        await tgBot.sendMessage(alertChatID, '🔄 Обновление, перезапуск...');
        isShuttingDown = true;
        try {
            const { head, proxyOk } = await runOrchestratorUpdate(__dirname);
            console.log('[update] git:', head, 'proxy:', proxyOk);
            await sendAlert(`✅ Git: ${head}\n${proxyOk ? '✅ VPN/proxy OK' : '⚠️ VPN/proxy — bash xray-check.sh'}`);
        } catch (err) {
            await sendAlert(`❌ Git: ${err.message}`);
        } finally {
            // ВСЕГДА перезапускаем оркестратор
            console.log('🔄 Перезапуск оркестратора после /update');
            process.exit(0);
        }
    });
    
    tgBot.onText(/\/ping/, async (msg) => {
        if ((Date.now() / 1000) - msg.date > 10) return;
        await tgBot.sendMessage(alertChatID, formatOrchestratorPing(getWorkerHealthStats(bots, workers), bots));
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
            requestInfoFromGo();
            setTimeout(() => scheduleAutoStart('open+3s'), 3000);
        });

        socket.on('message', async (data) => {
            try {
                const dataObj = JSON.parse(data);
                
                if (dataObj.action === "json_update" && Array.isArray(dataObj.data)) {
                    const merged = applyGoJsonUpdate(itemsBuying, dataObj.data);
                    for (const [username, _] of workers) {
                        safePostMessage(username, { type: 'items_buying', data: merged });
                    }
                    itemsBuying = merged;
                } else if (dataObj.action === 'funauth_result' || dataObj.action === 'funauth_no_accounts') {
                    await handleFunauthGoMessage(dataObj, workerStatusCtx());
                } else if (dataObj.prices) {
                    handleServerPriceMessage(dataObj);
                }
            } catch (e) {
                await sendAlert(`❌ Ошибка обработки WebSocket сообщения: ${e.message}`);
            }
        });

        socket.on('close', () => {
            console.log('❌ WebSocket отключен — боты продолжают с пустым списком товаров');
            isSocketOpen = false;
            catalog = [];
            lastPrices = {};
            applyPricesToBots({
                catalog,
                prices: lastPrices,
                bots,
                workers,
                safePostMessage,
            });
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
}, 120000);

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
    setTimeout(() => scheduleAutoStart('boot'), 1500);
    console.log('📌 боты стартуют сами (без Go — пустой список товаров)');
}

main().catch(async (error) => {
    await sendAlert(`❌ Критическая ошибка при запуске: ${error.message}`);
    process.exit(1);
});