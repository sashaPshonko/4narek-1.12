import fs from 'fs/promises';
import mineflayer from 'mineflayer';
import { createLogger, transports, format } from 'winston';
import { workerData, parentPort } from 'worker_threads';
import { writeFile, rename } from 'fs/promises';
import { join } from 'path';
import net from 'net';
import { generateKey } from 'crypto';
import protodef from 'protodef';
import zlib from 'zlib';

// ========== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ==========
/** Go-тип бота: покупаем/продаём только предметы с catalog.type === botGoType */
const botGoType = workerData.goType || null;
let itemPrices = workerData.itemPrices;
let itemsBuying = [];
let needReset = false;
let mu = false
let netakbistro = true
let enoughItems = false
let isKrush = false
let needSendAH = true
let typeSell = ""

let sellNeedRestart = false
let currentSellItem = null; // временный предмет для продажи

// Глобальные переменные для состояния бота
let botStartTime = Date.now() - 55000
let botAhFull = false
let botTimeReset = Date.now()
let botLogin = true
let botTimeActive = Date.now()
let botTimeLogin = Date.now()
let botPrices = []
let botCount = 0
let botAh = []
let botNeedSell = false
let botStartClickTime = null
let botUpdateWindow = false
let botMenu = 'Анализ аукциона'
let botKey = null
let botType = ""
let botTypeSell = null

parentPort.on('message', (data) => {
    if (data.type === 'price') {
        needReset = true;
        itemPrices = data.data;
    }
    if (data.type === 'items_buying') {
        itemsBuying = data.data;
    }
});

// Тайминги (антиспам / антибан)
const ANARCHY_JOIN_WAIT_MS = 11000;

const WARPS = ['mine', 'casino', 'case', 'shop', 'portal', 'palach', 'fisher', 'stash'];
const WARP_COOLDOWN_MS = 55000;
const WARP_WAIT = { min: 7500, max: 9500 };
const MOVE_SESSION = { min: 3500, max: 5500 };
const MOVE_HOLD = { min: 400, max: 900 };
const MOVE_PAUSE = { min: 300, max: 700 };
const AH_AFTER_MOVE = { min: 2000, max: 3500 };
const AH_CMD_WAIT = { min: 1200, max: 1800 };
const AFK_RECOVERY_WAIT = { min: 3000, max: 5000 };
const AFK_RECOVERY_COOLDOWN_MS = 12000;
const AFK_MESSAGE_MUTE_MS = 30000;
const IDLE_SOFT_MS = 30000;
const IDLE_HARD_MS = 120000;
const ANTI_AFK_WALK_INTERVAL_MS = 55000;
const MOVE_KEYS = ['forward', 'back', 'left', 'right'];

const DELAY = {
    TOSS: { min: 1500, max: 4500 },
    WINDOW: { min: 1500, max: 4500 },
    BUY: { min: 800, max: 1400 },
    CHAT: { min: 1000, max: 4500 },
    RTP_TELEPORT: { min: 8000, max: 9500 },
};

let lastWarpTime = 0;
let lastSellWalkAt = 0;
let walkInProgress = false;
let sellAfkAbort = false;
let afkRecoveryBusy = false;
let lastAfkRecoveryAt = 0;
let afkMessageMutedUntil = 0;
let serverInAfkMode = false;
let idleWatchBusy = false;
let botReadySent = false;

const analysisAH = 'Анализ аукциона';
const myItems = 'Хранилище';
const setAH = 'Установка аукциона';

const slotToReloadAH = 49;

const ahCommand = `/ah search ${workerData.item}`;

let type = "";

// ========== ЗАПРЕЩЁННЫЕ ЧАРЫ ПО ТИПАМ ПРЕДМЕТОВ ==========
const forbiddenEnchantsByType = {
    // Мечи — тяжелый, нестабильный, отдача
    "netherite_sword": [
        "heavy",
        "unstable",
    ],

    "diamond_sword": [
        "heavy",
        "unstable",
    ],

    // Броня (шлем, нагрудник, штаны, ботинки) — только шипы
    "netherite_helmet": [
        "minecraft:thorns"
    ],
    "netherite_chestplate": [
        "minecraft:thorns"
    ],
    "netherite_leggings": [
        "minecraft:thorns"
    ],
    "netherite_boots": [
        "minecraft:thorns"
    ],

    // Кирки — свои запреты (если нужны)
    "netherite_pickaxe": [
        "heavy",
        "unstable",
    ],

    // Элитры
    "elytra": [
    ]
};

function hasForbiddenEnchant(itemType, allEnchants, configEffects = []) {
    const forbiddenList = forbiddenEnchantsByType[itemType];
    if (!forbiddenList || forbiddenList.length === 0) return false;

    const allowedByConfig = new Set(
        (configEffects || []).map((e) => e?.name).filter(Boolean)
    );

    return allEnchants.some((enchant) => {
        if (!enchant?.name) return false;
        if (allowedByConfig.has(enchant.name)) return false;
        return forbiddenList.includes(enchant.name);
    });
}

const minBalance = 10000000;

const leftMouseButton = 0;
const noShift = 0;
const firstInventorySlot = 9;
const lastInventorySlot = 44;
const firstAHSlot = 0;
const lastAHSlot = 44;
const firstSellSlot = 36;

const anarchyCommand = `/an${workerData.anarchy}`;

const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.colorize(),
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => {
            return `${timestamp} ${level}: ${message}`;
        })
    ),
    transports: [new transports.Console()]
});

function getDurabilityPercent(item) {
    if (!item.maxDurability) return 1;
    const damageComp = item.components?.find(c => c.type === 'damage');
    const damage = damageComp?.data || 0;
    return (item.maxDurability - damage) / item.maxDurability;
}

function getSellPriceWithDurability(item, itemPrices) {
    const config = findMatchingConfigItem(item, itemPrices);
    if (!config) return 0;

    const durabilityPercent = getDurabilityPercent(item);

    // Минимальный порог прочности 20%
    if (durabilityPercent < 0.5) return 0;

    // Базовая цена с учётом прочности
    let price = Math.floor(config.priceSell * durabilityPercent);

    // Сохраняем последние 2 цифры от оригинальной цены
    const marker = config.priceSell % 100;
    price = Math.floor(price / 100) * 100 + marker;

    return price;
}

function getMaxBuyPriceWithDurability(item, itemPrices) {
    const config = findMatchingConfigItem(item, itemPrices);
    if (!config) return 0;

    const durabilityPercent = getDurabilityPercent(item);

    // Минимальный порог прочности 20%
    if (durabilityPercent < 0.5) return 0;

    // Цена покупки с учётом прочности (без наценки)
    let price = Math.floor(config.priceSell * durabilityPercent);

    // Сохраняем последние 2 цифры
    const marker = config.priceSell % 100;
    price = Math.floor(price / 100) * 100 + marker;

    return price;
}

async function launchBookBuyer(name, password, anarchy) {

    await delay(getRandomDelayInRange(0, 10000));

    const bot = mineflayer.createBot({
        host: 'mc.funtime.su',
        port: 25565,
        username: name,
        password: password,
        version: '1.21.4',
        chatLengthLimit: 256,
    });

    const loginCommand = `/l ${name}`;

    console.warn = () => { };

    bot.once('login', async () => {
        botStartTime = Date.now() - 55000;
        botAhFull = false;
        botTimeReset = Date.now();
        botLogin = true;
        touchActivity();
        botPrices = [];
        botCount = 0;
        botAh = [];
        botNeedSell = false;
        lastSellWalkAt = Date.now();
        botStartClickTime = null;
        botUpdateWindow = false;
        botMenu = analysisAH;
        botReadySent = false;

        logger.info(`${name} успешно проник на сервер.`);
        await rnd(DELAY.CHAT);
        bot.chat(loginCommand);
        await rnd(DELAY.CHAT);
        bot.chat(anarchyCommand);
        markAnarchyJoin();
        await waitAnarchyReady();

        await safeAH(bot);
    });

    bot.on("resourcePack", (u, h) => {
        console.log(u, h)
        if (bot._client) {
            bot._client.write('resource_pack_receive', {
                uuid: h.ascii,
                result: 0
            });
            console.log('✅ Отправлено подтверждение загрузки ресурспака');
        }
    })

    bot.on('end', (reason) => {
        console.log(`⚠️ Соединение закрыто: ${reason || 'без причины'}`)
        process.exit(1);
    });

    bot.on('kicked', (reason) => {
        console.log(JSON.stringify(`kicked - ${JSON.stringify(reason)}`));
        process.exit(1);
    });

    bot.on('error', (err) => {
        console.log(err);
        process.exit(1);
    });

    bot.on('physicsTick', () => {
        if (idleWatchBusy || walkInProgress || afkRecoveryBusy) return;

        const idle = Date.now() - botTimeActive;

        if (mu) {
            if (idle < IDLE_HARD_MS) return;
            idleWatchBusy = true;
            (async () => {
                try {
                    logger.info(`${name} - watchdog: продажа зависла >${IDLE_HARD_MS / 1000}с`);
                    await recoverFromAfk(bot, name);
                } finally {
                    idleWatchBusy = false;
                }
            })();
            return;
        }

        if (idle < IDLE_SOFT_MS) return;

        idleWatchBusy = true;
        (async () => {
            try {
                if (mu) return;

                logger.info(`${name} - watchdog: нет активности ${Math.floor(idle / 1000)}с`);
                touchActivity();
                botMenu = analysisAH;

                if (idle >= IDLE_HARD_MS) {
                    if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
                    await rnd(DELAY.CHAT);
                    await antiAfkMovement(bot);
                    bot.chat(anarchyCommand);
                    await delay(400);
                }

                await safeAH(bot);
            } finally {
                idleWatchBusy = false;
            }
        })();
    });

    botStartTime = Date.now() - 240000;

    bot.on('windowOpen', async () => {
        let key = "";
        switch (botMenu) {
            case analysisAH:
                logger.info(`${name} - ${botMenu}`);
                touchActivity();
                generateRandomKey(bot);
                key = botKey;
                const resetime = Math.floor((Date.now() - botTimeReset) / 1000);

                const hasItemsToSell = hasSellableItemsInInventory(bot, itemPrices);
                const walkDue = Date.now() - lastSellWalkAt >= ANTI_AFK_WALK_INTERVAL_MS;

                if (walkDue || (botNeedSell && hasItemsToSell)) {
                    if (hasItemsToSell) {
                        logger.info(`${name} - продажа`);
                    } else {
                        logger.info(`${name} - прогулка anti-AFK (${Math.floor((Date.now() - lastSellWalkAt) / 1000)}с без прогулки)`);
                    }
                    await sellItems(bot, itemPrices);
                    break;
                }

                if (botNeedSell && !hasItemsToSell) {
                    botNeedSell = false;
                }

                if (resetime > 60 || needReset || enoughItems) {
                    logger.info(`${name} - ресет`);
                    botMenu = myItems;
                    await safeClickBuy(bot, 46, delayMs(DELAY.WINDOW), key);
                    break;
                }



                let count = 0;
                for (let i = firstInventorySlot; i <= lastInventorySlot; i++) {
                    if (bot.inventory.slots[i]) count++;
                }

                if (count >= 36 - botCount) {
                    logger.error('Инвентарь заполнен');
                    await sellItems(bot, itemPrices);
                    break;
                }

                if (bot.currentWindow.slots[0] && bot.currentWindow.slots[0].name?.includes('stained_glass')) {
                    await safeClickBuy(bot, 31, delayMs(DELAY.WINDOW), key)
                    break
                }

                logger.info(`${name} - поиск лучшего предмета`);
                let slotToBuy = await getBestAHSlot(bot, itemPrices);

                switch (slotToBuy) {
                    case null:
                        botMenu = analysisAH;
                        await safeClickBuy(bot, slotToReloadAH, delayMs(DELAY.WINDOW), key);
                        break;
                    default:
                        if (netakbistro) {
                            netakbistro = false;
                            await safeClickBuy(bot, slotToBuy, 2355, key);
                        } else if (slotToBuy < 9) {
                            await safeClickBuy(bot, slotToBuy, delayMs(DELAY.BUY) * (slotToBuy + 2), key);
                        } else {
                            await safeClickBuy(bot, slotToReloadAH, delayMs(DELAY.WINDOW), key);
                        }
                        break;
                }
                break;

            case myItems:
                generateRandomKey(bot);

                if (needSendAH) {
                    botAh = []
                    for (let i = 0; i < 8; i++) {
                        const currentSlot = bot.currentWindow?.slots[i];
                        if (currentSlot) {
                            botCount++;
                            const id = getIDByEnchantments(currentSlot, itemPrices);
                            botAh.push(id);
                        } else break;
                    }

                    parentPort.postMessage({ name: 'items', username: bot.username, items: botAh });
                    needSendAH = false

                    const inv = []
                    for (let i = 0; i <= lastInventorySlot; i++) {
                        const slotData = bot.inventory.slots[i];
                        if (!slotData) continue;

                        const config = findMatchingConfigItem(slotData, itemPrices);
                        if (config) {
                            inv.push(config.id);
                        }
                    }
                    const msg = { name: "inventory", data: inv, username: bot.username }
                    parentPort.postMessage(msg)
                }

                if (!bot.currentWindow?.slots[0]) enoughItems = false
                key = botKey;
                if (bot.currentWindow.slots[27]) {
                    logger.error('суки обновили аукцион');
                    break;
                }
                needReset = false;
                logger.info(`${name} - ${botMenu}`);

                botCount = 0;
                botAh = [];
                let slot = null;

                 if (Math.floor((Date.now() - botTimeReset) / 1000) > 60) {
                    botTimeReset = Date.now();
                    if (bot.currentWindow?.slots[0]) {
                        await safeClickBuy(bot, 52, delayMs(DELAY.WINDOW), key);
                        break
                    }
                }

                // Проверка цен (оставляем)
                for (let i = 7; i >= 0; i--) {
                    const currentSlot = bot.currentWindow?.slots[i];
                    if (!currentSlot) continue;

                    const priceOnAH = getPriceFromItem(currentSlot);
                    const priceSell = getSellPriceWithDurability(currentSlot, itemPrices);

                    if (priceSell !== priceOnAH || enoughItems) {
                        logger.error(`chnge ${priceSell} ${priceOnAH}`);
                        botAhFull = false;
                        slot = i;
                        break;
                    }
                }

                if (slot !== null) {
                    botAhFull = false;
                    botNeedSell = true;
                    botMenu = myItems;
                    await safeClickBuy(bot, slot, delayMs(DELAY.BUY) * (slot + 1), key);
                    break;
                }

                // ← ВОТ ЭТУ ЧАСТЬ ВЕРНУТЬ

                botMenu = analysisAH;
                await safeClickBuy(bot, 46, delayMs(DELAY.WINDOW), key);

                break;
            case setAH:
                generateRandomKey(bot);
                key = botKey;
                logger.info(`${name} - ${botMenu}`);
                botMenu = analysisAH;
                await safeClickBuy(bot, 46, delayMs(DELAY.WINDOW), key);
                break;

            case "clan":
                logger.info(`${bot.username} ${botMenu}`);
                generateRandomKey(bot);

                let countItems = countTotalItemsInWindow(bot, itemPrices);
                if (botAhFull && countItems === 0) {
                    const slot = findFirstMatchingSlotInInventory(bot, itemPrices);
                    if (slot) {
                        logger.info(`${bot.username} добавил`);
                        await safeClickBuy(bot, slot, delayMs(DELAY.WINDOW), botKey);
                    }
                } else if (!botAhFull && countItems > 0) {
                    const slot = findFirstMatchingSlotInWindow(bot, itemPrices);
                    if (slot) {
                        logger.info(`${bot.username} забрал`);
                        botNeedSell = true;
                        await safeClickBuy(bot, slot, delayMs(DELAY.WINDOW), botKey);
                    }
                }
                logger.info(`${bot.username} никуда не кликнул`);
                await rnd(DELAY.CHAT);
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow);

                break;

            case "rtp":
                await safeClick(bot, 0, delayMs(DELAY.WINDOW));
                await rnd(DELAY.RTP_TELEPORT);

                // Очищаем инвентарь от мусора
                for (let i = firstAHSlot; i < lastInventorySlot; i++) {
                    if (sellNeedRestart) {
                        sellNeedRestart = false;
                        logger.info(`${bot.username} - очистка прервана`);
                        break;
                    }
                    const slotData = bot.inventory.slots[i];
                    if (!slotData) continue;
                    if (!isItemMatchingConfig(slotData, itemPrices)) {
                        await bot.tossStack(slotData);
                        await rnd(DELAY.TOSS);
                    }
                }

                // Запускаем продажу заново
                logger.info(`${bot.username} - перезапуск продажи после телепорта`);
                await sellItems(bot, itemPrices);
                break;
        }
    });

    bot.on('message', async (message) => {
        const messageText = message.toString();
        if (!messageText.includes('режиме AFK')) {
            console.log(messageText);
        }

        if (messageText.includes('[☃] Вы успешно купили')) {
            botNeedSell = true;
            logger.info(`${name} - [LOG] МЫ купили на аукционе, botNeedSell=true`);
            let balanceStr = messageText;
            balanceStr = balanceStr.replace(/\D/g, '');
            const balance = parseInt(balanceStr);
            parentPort.postMessage({ name: 'buy', id: botType, price: balance });
            return;
        } //
        if (messageText.includes('[❌] Вы не можете выкидывать этот предмет в этом месте!')) {
            sellNeedRestart = true;
            botMenu = 'rtp'
            bot.chat('/rtp')
            return;
        }

        if (messageText.includes('BotFilter >> Введите номер с картинки в чат')) {
            parentPort.postMessage(`${workerData.username} - ввести капчу`);
            return;
        }
//
        if (messageText.toLowerCase().includes('вы забанены')) {
            parentPort.postMessage(`${workerData.username} - забанен`);
            return;
        }
        if (messageText.toLowerCase().includes('Отключите VPN и Proxy и повторите попытку входа')) {
            parentPort.postMessage(`${workerData.username} - vpn спалили`);
            return;
        }

        if (messageText.includes('[✘] Ошибка! По такой цене')) {
            console.log('[✘] Ошибка! По такой цене ', workerData.itemID);
            return;
        }

        if (messageText.includes('[✘] Ошибка! Этот товар уже Купили!')) {
            await safeClick(bot, slotToReloadAH, delayMs(DELAY.WINDOW));
            return;
        }

        if (messageText.includes('Сервер заполнен')) {
            mu = false;
            botStartTime = Date.now() - 240000;
            botAhFull = false;
            botTimeReset = Date.now() - 60000;
            botLogin = true;
            touchActivity();
            botTimeLogin = Date.now();
            botPrices = [];
            botCount = 0;
            netakbistro = true;
            await rnd(DELAY.CHAT);
            bot.chat(anarchyCommand);
            markAnarchyJoin();
            await waitAnarchyReady();
            botMenu = analysisAH;
            await safeAH(bot);
            return;
        }

        if (isLobbyBroadcastMessage(messageText)) {
            logger.info(`${name} - лобби, продажа`);
            await sellItems(bot, itemPrices);
            return;
        }

        if (messageText.includes('Чтобы ваш Аккаунт')) {
            if (!botReadySent) {
                botReadySent = true;
                parentPort.postMessage({ name: 'success', username: workerData.username });
            }
            return;
        }

        if (messageText.includes('не можете продать') && messageText.includes('Воздух')) {
            return;
        }

        if (messageText.includes('[☃] У Вас купили')) {
            botAhFull = false;
            let balanceStr = messageText;
            balanceStr = balanceStr.replace(/\D/g, '');
            const balance = parseInt(balanceStr);
            const id = getIdBySellPrice(itemPrices, balance);
            parentPort.postMessage({ name: 'sell', id: id, price: balance });
            botNeedSell = true;
            logger.info(`${name} - [LOG] У ВАС КУПИЛИ: ${messageText.trim()} → botNeedSell=true`);
            return;
        }

        if (messageText.includes('[☃]') && messageText.includes('выставлен на продажу!')) {
            if (botTypeSell) {
                parentPort.postMessage({ name: 'try-sell', id: botTypeSell });
            }
            botCount++;
            return;
        }

        if (messageText.includes('Данная команда недоступна в режиме AFK')) {
            onServerAfk(bot, name);
            return;
        }

        if (messageText.includes('Не так быстро..') ||
            messageText.includes('[☃] После входа на режим необходимо немного подождать')) {

            await rnd(DELAY.CHAT);
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
            await rnd(DELAY.CHAT);

            const isLoginCooldown = messageText.includes('После входа');
            await walk(bot, false);

            if (isLoginCooldown) {
                await waitAnarchyReady();
            } else {
                await rnd(DELAY.CHAT);
            }

            botMenu = analysisAH;
            if (!mu) await safeAH(bot);
            return;
        }

        if (messageText.includes('[☃] Не удалось выставить') ||
            messageText.includes('[✘] Ошибка! У Вас переполнено Хранилище!')) {
            enoughItems = true
            botAhFull = true;
            return;
        }

        if (messageText.includes('[⚠] Здесь нет команд!')) {
            await walk(bot);
            touchActivity();
            bot.chat(anarchyCommand);
            markAnarchyJoin();
            await waitAnarchyReady();
            await safeAH(bot);
        }



        if (messageText.includes('[✘] Ошибка! У Вас не хватает Монет!')) {
            await rnd(DELAY.CHAT);
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
            await rnd(DELAY.CHAT);
            bot.chat('/clan withdraw 3000000');
            await rnd(DELAY.CHAT);
            botMenu = analysisAH;
            await safeAH(bot);
            return;
        }

        if (messageText.includes('[⚠] Данной команды не существует!')) {
            bot.chat(anarchyCommand);
            markAnarchyJoin();
            await waitAnarchyReady();
            botMenu = analysisAH;
            await safeAH(bot);
            return;
        }

        if (messageText.includes('[$] Ваш баланс:')) {
            let balanceStr = messageText;
            if (messageText.includes('.')) balanceStr = balanceStr.slice(0, -3);
            balanceStr = balanceStr.replace(/\D/g, '');
            const balance = parseInt(balanceStr);
            if (isNaN(balance)) {
                logger.error('баланс NAN');
                return;
            }
            if (balance - minBalance >= 10000000) {
                await rnd(DELAY.CHAT);
                bot.chat(`/clan invest ${balance - minBalance}`);
            }
            return;
        }

        if (messageText.includes('[☃] Максимальная цена')) {
            let balanceStr = messageText;
            if (messageText.includes('.')) balanceStr = balanceStr.slice(0, -3);
            balanceStr = messageText.replace(/\./g, '').replace(/\D/g, '');
            const balance = parseInt(balanceStr);

            const slotHotBar = bot.quickBarSlot;
            const slot = transform(slotHotBar);
            const currentPrice = getPriceByEnchantments(bot.inventory.slots[slot], itemPrices);
            const id = getIDByEnchantments(bot.inventory.slots[slot], itemPrices);

            const basePrice = Math.floor(balance / 10000) * 10000;
            const marker = currentPrice % 100;
            let finalPrice = basePrice + marker;
            if (finalPrice > balance) finalPrice = basePrice - 100 + marker;

            parentPort.postMessage({ name: "set_max_price", type: id, price: finalPrice });
            return;
        }

        if (messageText.includes('[☃] Минимальная цена')) {
            let balanceStr = messageText;
            if (messageText.includes('.')) balanceStr = balanceStr.slice(0, -3);
            balanceStr = messageText.replace(/\./g, '').replace(/\D/g, '');
            const balance = parseInt(balanceStr);

            const slotHotBar = bot.quickBarSlot;
            const slot = transform(slotHotBar);
            const item = bot.inventory.slots[slot];
            if (!item) return;

            const currentPrice = getPriceByEnchantments(item, itemPrices);
            const id = getIDByEnchantments(item, itemPrices);
            const nacenka = getNacenkaByEnchantments(item, itemPrices);

            // Проверяем прочность предмета
            const durabilityPercent = getDurabilityPercent(item);
            const isDamaged = durabilityPercent < 0.8; // сломан более чем на 20%

            const basePrice = Math.ceil(balance / 10000) * 10000;
            const marker = currentPrice % 100;
            let finalPrice = basePrice + marker + nacenka;

            // Если предмет сильно сломан — не обновляем конфиг, а просто выставляем по цене сервера
            if (isDamaged) {
                logger.info(`${bot.username} - сломанный предмет (${Math.floor(durabilityPercent * 100)}%), выставляем по цене ${balance}`);
                bot.chat(`/ah sell ${balance}`);
                return;
            }

            // ← ДОБАВИТЬ проверку krush
            if (messageText.includes('круш')) {
                isKrush = true
                bot.chat(`/ah sell ${finalPrice}`)
                await rnd(DELAY.CHAT);
                bot.chat(`/ah sell ${finalPrice}`)
                isKrush = false
                return
            }

            parentPort.postMessage({ name: "set_min_price", type: id, price: finalPrice });
            return;
        }
    });
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

function getIdBySellPrice(itemPrices, val) {
    const foundItem = itemPrices.find(item => item.priceSell % 100 === val % 100);
    return foundItem ? foundItem.id : "";
}

function countTotalItemsInWindow(bot, itemPrices) {
    if (!bot.currentWindow || !bot.currentWindow.slots) return 0;
    let totalCount = 0;
    for (let slot = 0; slot <= 45; slot++) {
        const slotData = bot.currentWindow.slots[slot];
        if (!slotData) continue;
        if (isItemMatchingConfig(slotData, itemPrices)) totalCount++;
    }
    return totalCount;
}

function onServerAfk(bot, name) {
    serverInAfkMode = true;
    if (afkRecoveryBusy) return;
    if (Date.now() < afkMessageMutedUntil) {
        if (!mu && !walkInProgress) void waitOutOfAfk(bot, name);
        return;
    }
    if (Date.now() - lastAfkRecoveryAt < AFK_RECOVERY_COOLDOWN_MS) return;
    recoverFromAfk(bot, name);
}

async function waitOutOfAfk(bot, name) {
    if (!serverInAfkMode) return true;

    if (walkInProgress) {
        const deadline = Date.now() + 15000;
        while (walkInProgress && Date.now() < deadline) {
            await delay(200);
        }
    } else {
        await walk(bot, false);
        await rnd(AFK_RECOVERY_WAIT);
    }

    serverInAfkMode = false;
    return true;
}

async function sellItemOnAh(bot, price, name) {
    if (serverInAfkMode) {
        if (!await waitOutOfAfk(bot, name)) return false;
    }
    if (sellAfkAbort || !mu) return false;

    bot.chat(`/ah sell ${price}`);
    await rnd(DELAY.CHAT);
    bot.chat(`/ah sell ${price}`);
    touchActivity();
    return true;
}

async function sellItems(bot, itemPrices, botName = '') {
    const name = botName || bot.username;
    botNeedSell = false;
    needSendAH = true
    if (mu) {
        await rnd(DELAY.CHAT);
        await safeAH(bot);
        return;
    }
    mu = true;
    sellAfkAbort = false;
    bot.chat(anarchyCommand);
    await delay(400);

    let endSellTime = Date.now();
    const now = Date.now();
    if (now - lastWarpTime >= WARP_COOLDOWN_MS) {
        lastWarpTime = now;
        bot.chat(`/warp ${getRandomElement(WARPS)}`);
        endSellTime = Date.now() + 8000;
    }

    await antiAfkMovement(bot, getRandomDelayInRange(4500, 6000));
    lastSellWalkAt = Date.now();

    logger.info(`${bot.username} - прогулка завершена`);

    if (!await waitOutOfAfk(bot, name)) {
        mu = false;
        if (hasSellableItemsInInventory(bot, itemPrices)) botNeedSell = true;
        return;
    }

    try {
        await waitAnarchyReady();
        touchActivity();
        if (bot.currentWindow) {
            await rnd(DELAY.CHAT);
            bot.closeWindow(bot.currentWindow);
        }

        while (!botAhFull) {
            if (sellNeedRestart) {
                sellNeedRestart = false;
                logger.info(`${bot.username} - телепорт, прерываем продажу`);
                mu = false;
                return;
            }
            if (!mu || sellAfkAbort) {
                logger.info(`${bot.username} - продажа прервана`);
                return;
            }

            if (serverInAfkMode) {
                if (!await waitOutOfAfk(bot, name)) return;
            }

            while (isKrush) await delay(100)
            let soldAnything = false;

            for (let quickSlot = 0; quickSlot < 9; quickSlot++) {
                if (botAhFull || !mu || sellAfkAbort) break;
                while (isKrush) await delay(100)
                const slotIndex = firstSellSlot + quickSlot;
                const item = bot.inventory.slots[slotIndex];
                if (!isSellableItem(item)) continue;

                const price = getBestSellPrice(bot, item, itemPrices);
                if (price > 0) {
                    typeSell = getIDByEnchantments(item, itemPrices);
                    if (bot.quickBarSlot !== quickSlot) {
                        await rnd(DELAY.CHAT);
                        await bot.setQuickBarSlot(quickSlot);
                    }
                    await rnd(DELAY.CHAT);
                    if (!await sellItemOnAh(bot, price, name)) return;
                    soldAnything = true;
                } else if (isItemMatchingConfig(item, itemPrices)) {
                    await rnd(DELAY.TOSS);
                    await bot.tossStack(item);
                    touchActivity();
                }
            }

            if (!botAhFull) {
                let freeSlot = null;
                for (let i = 0; i < 9; i++) {
                    if (!bot.inventory.slots[i + firstSellSlot]) {
                        freeSlot = i;
                        break;
                    }
                }

                if (freeSlot !== null) {
                    for (let invSlot = firstInventorySlot; invSlot < firstSellSlot; invSlot++) {
                        if (!mu || sellAfkAbort) break;
                        while (isKrush) await delay(100)
                        if (botAhFull) break;
                        const item = bot.inventory.slots[invSlot];
                        if (!isSellableItem(item)) continue;

                        const price = getBestSellPrice(bot, item, itemPrices);
                        if (price > 0) {
                            typeSell = getIDByEnchantments(item, itemPrices);
                            await rnd(DELAY.CHAT);
                            await bot.setQuickBarSlot(freeSlot);
                            await rnd(DELAY.CHAT);
                            await bot.moveSlotItem(invSlot, firstSellSlot + freeSlot);
                            await rnd(DELAY.CHAT);
                            if (!await sellItemOnAh(bot, price, name)) return;
                            soldAnything = true;
                        } else if (isItemMatchingConfig(item, itemPrices)) {
                            await rnd(DELAY.TOSS);
                            await bot.tossStack(item);
                            touchActivity();
                        }
                    }
                }
            }

            if (!soldAnything) break;
        }
    } catch (error) {
        parentPort.postMessage(`ошибка продажи ${error}`)
        logger.error(`${bot.username} - Ошибка в sellItems: ${error.stack || error}`);
    } finally {
        if (sellAfkAbort) {
            sellAfkAbort = false;
            botStartTime = Date.now();
            mu = false;
            logger.info(`${bot.username} - продажа прервана (AFK), safeAH вызовет обработчик`);
            return;
        }

        touchActivity();
        logger.info(`${bot.username} - продажа завершена`);
        await rnd(DELAY.CHAT);

        for (let i = firstAHSlot; i < lastInventorySlot; i++) {
            if (sellNeedRestart) {
                sellNeedRestart = false;
                logger.info(`${bot.username} - очистка в finally прервана`);
                break;
            }
            const slotData = bot.inventory.slots[i];
            if (!isSellableItem(slotData)) continue;
            if (!isItemMatchingConfig(slotData, itemPrices)) {
                await rnd(DELAY.TOSS);
                await bot.tossStack(slotData);
            }
        }

        bot.chat('/balance');
        await rnd(DELAY.CHAT);

        if (!hasSellableItemsInInventory(bot, itemPrices)) {
            if (botNeedSell) {
                logger.info(`${bot.username} - [LOG] после sell: botNeedSell сброшен (инвентарь пуст для выставления)`);
            }
            botNeedSell = false;
        } else if (botNeedSell) {
            logger.info(`${bot.username} - [LOG] после sell: botNeedSell остаётся true (есть предметы в инвентаре)`);
        }

        botStartTime = Date.now();
        mu = false;
        logger.info(`${bot.username} - мьютекс снят`);
        await rnd(DELAY.CHAT);
        while (Date.now() < endSellTime) await delay(100)

        if (sellNeedRestart) {
            sellNeedRestart = false;
            logger.info(`${bot.username} - выход, перезапуск будет в rtp`);
            return;  // не вызываем safeAH, не меняем botMenu
        }

        botMenu = analysisAH;
        await safeAH(bot);
    }
}

function transform(num) {
    if (num < 0 || num > 8) return num;
    return 44 - (8 - num);
}

function getBestSellPrice(bot, item, itemPrices) {
    return getSellPriceWithDurability(item, itemPrices);
}

function getID(item, itemPrices) {
    const config = findMatchingConfigItem(item, itemPrices);
    return config ? config.id : 0;
}

function generateRandomKey(bot) {
    botKey = Math.random().toString(36).substring(2, 15);
}

function getRandomDelayInRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delayMs(range) {
    return getRandomDelayInRange(range.min, range.max);
}

async function rnd(range) {
    await delay(delayMs(range));
}

function touchActivity() {
    botTimeActive = Date.now();
}

function markAnarchyJoin() {
    botTimeLogin = Date.now();
}

async function waitAnarchyReady() {
    const remaining = botTimeLogin + ANARCHY_JOIN_WAIT_MS - Date.now();
    if (remaining > 0) await delay(remaining);
}

function isLobbyBroadcastMessage(text) {
    return text.includes('⚡ Наша группа ВК vk.com/funtime')
        || text.includes('⚡ Наш Телеграм t.me/funtime')
        || text.includes('⚡ Наш Дискорд dd.FunTime.su')
        || text.includes('⚡ Наш Сайт FunTime.su')
        || text.includes('⚡ Наши сообщества и соц. сети /links')
        || text.includes('⚡ Вы играете на FunTime! play.funtime.su');
}

async function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

async function safeClick(bot, slot, time) {
    await delay(time);
    if (bot.currentWindow) {
        touchActivity();
        await bot.clickWindow(slot, leftMouseButton, noShift);
    }
}

function releaseMovementKeys(bot) {
    MOVE_KEYS.forEach(move => bot.setControlState(move, false));
}

async function antiAfkMovement(bot, durationMs = null) {
    const duration = durationMs ?? getRandomDelayInRange(MOVE_SESSION.min, MOVE_SESSION.max);
    const endTime = Date.now() + duration;

    releaseMovementKeys(bot);

    while (Date.now() < endTime) {
        const randomMove = MOVE_KEYS[Math.floor(Math.random() * MOVE_KEYS.length)];
        bot.setControlState(randomMove, true);
        await delay(getRandomDelayInRange(MOVE_HOLD.min, MOVE_HOLD.max));
        bot.setControlState(randomMove, false);
        await delay(getRandomDelayInRange(MOVE_PAUSE.min, MOVE_PAUSE.max));
    }

    releaseMovementKeys(bot);
    touchActivity();
}

async function safeAH(bot) {
    const name = bot.username;
    if (mu || walkInProgress || afkRecoveryBusy) {
        logger.info(`${name} - safeAH пропуск (mu=${mu} walk=${walkInProgress} afk=${afkRecoveryBusy})`);
        return;
    }
    netakbistro = true;
    let key = botKey;
    touchActivity();
    botMenu = analysisAH;
    botUpdateWindow = true;
    while (key === botKey) {
        if (serverInAfkMode) {
            await waitOutOfAfk(bot, name);
            continue;
        }
        await antiAfkMovement(bot, getRandomDelayInRange(2500, 3500));
        await rnd(AH_AFTER_MOVE);
        bot.chat(ahCommand);
        await rnd(AH_CMD_WAIT);
    }
}

async function getAHSlotsIDs(bot, itemPrices) {
    if (!bot.currentWindow?.slots) return [];
    const ids = [];
    for (let i = 0; i < 8; i++) {
        if (bot.currentWindow?.slots[i]) {
            ids.push(getID(bot.currentWindow?.slots[i]), itemPrices);
        }
    }
    return ids;
}

async function getBestAHSlot(bot, itemPrices) {
    // await saveToJsonFile('pizdec.json', bot.currentWindow.slots)
    // return
    if (!bot.currentWindow?.slots) return null;

    for (let slot = firstAHSlot; slot <= 17; slot++) {
        const slotData = bot.currentWindow.slots[slot];
        if (!slotData) continue;

        const currentUUID = getItemUUID(slotData);

        if (currentUUID && itemsBuying?.includes(currentUUID)) {
            console.log(`⏭️ Пропускаем лот ${currentUUID}, уже в очереди на покупку`);
            continue;
        }

        const config = findMatchingConfigItem(slotData, itemPrices, {
            checkDurability: true,
            checkMissingEnchants: true
        });

        if (!config || !isConfigForBot(config)) continue;

        try {
            const price = getPriceFromItem(slotData);
            if (!price) continue;

            const maxBuyPrice = getMaxBuyPriceWithDurability(slotData, itemPrices);
            if (maxBuyPrice === 0) continue;

            if (price >= maxBuyPrice - config.nacenka) continue;
            if (!config.priceSell) continue;

            botType = config.id;
            if (!botType) logger.error('id undefined');

            parentPort.postMessage({ name: 'buying', data: currentUUID });
            return slotData.slot;
        } catch (error) {
            console.error(error);
            continue;
        }
    }
    return null;
}

function getItemUUID(item) {
    try {
        const customDataComp = item.components?.find(c => c.type === 'custom_data');
        if (!customDataComp) return null;

        const pubBukkit = customDataComp.data?.value?.PublicBukkitValues?.value;
        if (!pubBukkit) return null;

        const uuidArray = pubBukkit['auctions:if-uuid']?.value;
        if (!Array.isArray(uuidArray)) return null;

        return uuidArray.join(',');
    } catch (e) {
        parentPort.postMessage(`ошибка получаения юайди ${JSON.stringify(item)}`)
        console.log('Ошибка при получении UUID:', e.message);
        return null;
    }
}

function findFirstMatchingSlotInWindow(bot, itemPrices) {
    if (!bot.currentWindow?.slots) return null;
    for (let slot = 0; slot <= 45; slot++) {
        const slotData = bot.currentWindow.slots[slot];
        if (!slotData) continue;
        if (isItemMatchingConfig(slotData, itemPrices)) return slot;
    }
    return null;
}

function findFirstMatchingSlotInInventory(bot, itemPrices) {
    if (!bot.currentWindow?.slots) return null;
    for (let slot = 63; slot <= 89; slot++) {
        const slotData = bot.currentWindow.slots[slot];
        if (!slotData) continue;
        if (isItemMatchingConfig(slotData, itemPrices)) return slot;
    }
    return null;
}

function getPriceByEnchantments(slotData, itemPrices) {
    return getSellPrice(slotData, itemPrices);
}

function getIDByEnchantments(slotData, itemPrices) {
    return getItemId(slotData, itemPrices);
}

function getNacenkaByEnchantments(slotData, itemPrices) {
    return getItemNacenka(slotData, itemPrices);
}

function romanToArabic(roman) {
    const map = {
        'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5,
        'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10
    };
    return map[roman] || 1;
}

function extractCustomEnchantsFromItem(item) {
    const result = [];

    try {
        const customDataComp = item.components?.find(c => c.type === 'custom_data');
        const enchantsArray = customDataComp?.data?.value?.PublicBukkitValues?.value?.['minecraft:custom-enchantments']?.value?.value;

        if (Array.isArray(enchantsArray) && enchantsArray.length > 0) {

            for (const ench of enchantsArray) {
                const name = ench['minecraft:type']?.value;
                const lvl = ench['minecraft:level']?.value;

                if (name && typeof lvl === 'number') {
                    result.push({ name, lvl });
                }
            }

            return result;
        }
    } catch (e) {
    }


    const jsonStr = JSON.stringify(item);
    const valueRegex = /"value":"([^"]*)"/g;
    const matches = [];
    let match;
    while ((match = valueRegex.exec(jsonStr)) !== null) {
        matches.push(match[1]);
    }


    const textStrings = matches.filter(s => {
        if (!s || typeof s !== 'string') return false;
        const trimmed = s.trim();
        if (!trimmed) return false;
        if (/^#/.test(trimmed)) return false;
        return /[a-zA-Zа-яА-Я]/.test(trimmed);
    });


    const romanRegex = /^(I|II|III|IV|V|VI|VII|VIII|IX|X)$/;

    for (const str of textStrings) {
        const trimmed = str.trim();

        const lastSpaceIndex = trimmed.lastIndexOf(' ');
        if (lastSpaceIndex !== -1) {
            const possibleRoman = trimmed.substring(lastSpaceIndex + 1);
            if (romanRegex.test(possibleRoman)) {
                const name = trimmed.substring(0, lastSpaceIndex).trim();
                const lvl = romanToArabic(possibleRoman);
                result.push({ name, lvl });
                continue;
            }
        }

        result.push({ name: trimmed, lvl: 1 });
    }

    return result;
}

function getPriceFromItem(item) {
    const loreComp = item.components?.find(c => c.type === 'lore');
    if (!loreComp || !Array.isArray(loreComp.data)) {
        parentPort.postMessage(`нет лора для предмета ${item.name}: ${JSON.stringify(item)}`);
        return null;
    }

    for (const loreEntry of loreComp.data) {
        const strings = [];
        extractStrings(loreEntry, strings);

        const hasPriceMarker = strings.some(s => typeof s === 'string' && s.includes('Цен'));
        if (!hasPriceMarker) continue;

        for (const s of strings) {
            if (typeof s !== 'string') continue;
            const trimmed = s.trim();
            if (trimmed === '') continue;

            const withoutCommas = trimmed.replace(/,/g, '');
            if (/^\d*\.?\d+$/.test(withoutCommas)) {
                const num = parseFloat(withoutCommas);
                if (!isNaN(num)) {
                    if (num > 20000) {
                        return num; // нормальная цена
                    } else {
                        parentPort.postMessage(`подозрительная цена ${num} для ${item.name}: ${JSON.stringify(item)}`);
                        return null;
                    }
                }
            }
        }
    }

    // Цена не найдена ни в одной строке с маркером
    parentPort.postMessage(`не удалось извлечь цену для ${item.name} (нет подходящей строки с числом): ${JSON.stringify(item)}`);
    return null;
}

function extractStrings(node, out) {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
        for (const item of node) {
            extractStrings(item, out);
        }
    } else if (typeof node === 'object') {
        if (node.type === 'string' && node.hasOwnProperty('value')) {
            const val = node.value;
            if (typeof val === 'string') {
                out.push(val);
            } else {
                extractStrings(val, out);
            }
        } else {
            for (const val of Object.values(node)) {
                extractStrings(val, out);
            }
        }
    } else if (typeof node === 'string') {
        out.push(node);
    }
}

function isConfigForBot(config) {
    if (!config) return false;
    if (!botGoType) return true;
    return config.type === botGoType;
}

function findMatchingConfigItem(item, itemPrices, options = { checkDurability: true, checkMissingEnchants: true }) {
    if (!item || !itemPrices?.length) return null;

    let filteredConfig = itemPrices.filter(config => config.id.endsWith('1.21'));
    if (botGoType) {
        filteredConfig = filteredConfig.filter((config) => config.type === botGoType);
    }
    if (filteredConfig.length === 0) return null;

    const sortedConfig = [...filteredConfig].sort((a, b) => b.num - a.num);

    const numericToName = {
        33: 'minecraft:sharpness',
        10: 'minecraft:fire_aspect',
        40: 'minecraft:unbreaking',
        36: 'minecraft:sweeping',
        17: 'minecraft:knockback',
        18: 'minecraft:looting',
        28: "minecraft:protection",
        27: "minecraft:projectile_protection",
        23: "minecraft:mending",
        39: "minecraft:thorns",
        11: "minecraft:fire_protection",
        1: "minecraft:aqua_affinity",
        31: "minecraft:respiration",
        7: "minecraft:depth_strider",
        9: "minecraft:feather_falling",
        13: "minecraft:fortune",
        8: "minecraft:efficiency",
    };

    const customNameMap = {
        'Яд': 'poison',
        'Вампиризм': 'vampirism',
        'Детекция': 'detection',
        'Тяжелый': 'heavy',
        'Нестабильный': 'unstable',
        'Бульдозер': 'buldozing',
        'Магнит': 'magnet',
        'Паутина': 'web',
        'Авто-плавка': 'smelting',
    };

    const vanillaEnchants = [];
    if (item.components && Array.isArray(item.components)) {
        const enchComponent = item.components.find(c => c && c.type === 'enchantments');
        if (enchComponent?.data?.enchantments && Array.isArray(enchComponent.data.enchantments)) {
            vanillaEnchants.push(...enchComponent.data.enchantments.map(e => {
                if (!e) return null;

                let name = e.id;
                if (typeof name === 'number') {
                    name = numericToName[name] || `enchantment.${name}`; // fallback
                }

                let lvl = e.level;
                if (lvl === undefined || lvl === null) {
                    lvl = 1;
                }

                return { name, lvl };
            }).filter(e => e !== null));
        }
    }

    const rawCustomEnchants = extractCustomEnchantsFromItem(item);

    const customEnchants = rawCustomEnchants.map(ench => {
        const englishName = customNameMap[ench.name];
        if (englishName) {
            return { name: englishName, lvl: ench.lvl };
        } else {
            return ench;
        }
    });

    const allEnchants = [...vanillaEnchants, ...customEnchants];

    for (const configItem of sortedConfig) {
        if (item.name !== configItem.name) continue;

        const areEnchantsValid = configItem.effects?.every(required => {
            const foundEnchant = allEnchants.find(e => e && e.name === required.name);
            return foundEnchant && foundEnchant.lvl >= required.lvl;
        });

        if (!areEnchantsValid) continue;

        if (hasForbiddenEnchant(item.name, allEnchants, configItem.effects)) {
            continue
        }

        // if (item.name === 'netherite_pickaxe' &&
        //     allEnchants.some(en => en && en.name === 'minecraft:silk_touch') &&
        //     !allEnchants.some(en => en && en.name === 'smelting')) {
        //     continue;
        // }

        // if (options.checkDurability && item.maxDurability) {
        //     let coefficient = 0.9;
        //     if (allEnchants.some(en => en && en.name === 'minecraft:mending')) coefficient = 0.75;
        //     const damageComp = item.components?.find(c => c.type === 'damage');
        //     const damage = damageComp?.data || 0;
        //     const durabilityLeft = item.maxDurability - damage;
        //     if (durabilityLeft < item.maxDurability * coefficient) continue;
        // }

        return configItem;
    }

    return null;
}

function getSellPrice(item, itemPrices) {
    const config = findMatchingConfigItem(item, itemPrices);
    return config ? config.priceSell : 0;
}

function getItemId(item, itemPrices) {
    const config = findMatchingConfigItem(item, itemPrices);
    return config ? config.id : "";
}

function getItemNacenka(item, itemPrices) {
    const config = findMatchingConfigItem(item, itemPrices);
    return config ? config.nacenka : 0;
}

function isItemMatchingConfig(item, itemPrices) {
    return findMatchingConfigItem(item, itemPrices) !== null;
}

function hasSellableItemsInInventory(bot, itemPrices) {
    for (let slot = firstInventorySlot; slot <= lastInventorySlot; slot++) {
        const item = bot.inventory.slots[slot];
        if (!isSellableItem(item)) continue;
        if (getBestSellPrice(bot, item, itemPrices) > 0) return true;
        if (isItemMatchingConfig(item, itemPrices)) return true;
    }
    return false;
}

function isSellableItem(item) {
    if (!item) return false;
    if (item.name === 'air' || item.type === 0) return false;
    return item.count > 0;
}

if (workerData) {
    launchBookBuyer(workerData.username, workerData.password, workerData.anarchy);
}

function getRandomElement(array) {
    if (!Array.isArray(array) || array.length === 0) {
        throw new Error("Input must be a non-empty array");
    }
    return array[Math.floor(Math.random() * array.length)];
}


async function recoverFromAfk(bot, name) {
    if (afkRecoveryBusy) return;
    if (Date.now() - lastAfkRecoveryAt < AFK_RECOVERY_COOLDOWN_MS) return;

    afkRecoveryBusy = true;
    lastAfkRecoveryAt = Date.now();
    afkMessageMutedUntil = Date.now() + AFK_MESSAGE_MUTE_MS;
    serverInAfkMode = true;

    const wasSelling = mu;

    try {
        logger.info(`${name} - AFK, прерываем${wasSelling ? ' продажу' : ''}`);
        generateRandomKey(bot);
        if (wasSelling) {
            sellAfkAbort = true;
            mu = false;
        }

        if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
        await rnd(DELAY.CHAT);

        if (!await waitOutOfAfk(bot, name)) {
            logger.error(`${name} - не вышли из AFK`);
            if (wasSelling && hasSellableItemsInInventory(bot, itemPrices)) {
                botNeedSell = true;
            }
            return;
        }

        serverInAfkMode = false;
        botMenu = analysisAH;
        touchActivity();

        logger.info(`${name} - AFK recovery: возврат к аукциону`);
        afkRecoveryBusy = false;
        await safeAH(bot);
    } catch (err) {
        logger.error(`${name} - ошибка AFK recovery: ${err.message}`);
    } finally {
        afkRecoveryBusy = false;
    }
}

async function walk(bot, withWarp = true) {
    if (walkInProgress) return;
    walkInProgress = true;

    try {
        await rnd(DELAY.CHAT);

        if (withWarp) {
            const now = Date.now();
            if (now - lastWarpTime >= WARP_COOLDOWN_MS) {
                lastWarpTime = now;
                bot.chat(`/warp ${getRandomElement(WARPS)}`);
                await rnd(WARP_WAIT);
            }
            await antiAfkMovement(bot);
        } else {
            await antiAfkMovement(bot, getRandomDelayInRange(4500, 6500));
        }

        await rnd(DELAY.CHAT);
    } finally {
        walkInProgress = false;
    }
}

async function safeClickBuy(bot, slot, time, key) {
    let timeDelay = time;
    if (botUpdateWindow) {
        botUpdateWindow = false;
        botStartClickTime = Date.now();
    } else {
        timeDelay = time - (Date.now() - botStartClickTime);
        if (timeDelay <= 0) timeDelay = 0;
    }

    await delay(timeDelay);
    if (botKey != key) {
        console.log('твари ах обновили и теперь так');
        return;
    }
    botUpdateWindow = true;
    if (bot.currentWindow) {
        touchActivity();
        await bot.clickWindow(slot, leftMouseButton, 1);
    }
}

async function saveToJsonFile(filePath, data) {
    const tempPath = `${filePath}.tmp`;
    try {
        const jsonString = JSON.stringify(data, null, 2);
        await writeFile(tempPath, jsonString, 'utf8');
        await rename(tempPath, filePath);
        console.log('✅ Данные успешно сохранены:', filePath);
    } catch (error) {
        console.error('❌ Ошибка при сохранении:', error);
        try { await fs.unlink(tempPath); } catch { }
    }
}