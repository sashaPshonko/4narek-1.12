import fs from 'fs/promises';
import mineflayer from 'mineflayer';
import { workerData, parentPort } from 'worker_threads';
import { rnd } from './delay/delay.mjs';
import {
    getSlotInfo,
    getItemUUID,
    getPriceFromAhItem,
    findMatchingConfigItem,
} from './items/slotInfo.mjs';

const STORAGE_AH_SLOTS = 5;

const firstAHSlot = 0;
const lastAHSlot = 17;
const slotToReloadAH = 49;
const slotGlass = 31;
const slotToStorage = 46;
const leftMouseButton = 0;
const shiftClick = 1;

const firstInventorySlot = 9;
const lastInventorySlot = 35;
const firstHotbarSlot = 36;
const lastHotbarSlot = 44;
const warps = ['mine', 'casino', 'case', 'shop', 'portal', 'palach', 'fisher', 'stash'];
const moves = ['forward', 'back', 'left', 'right'];

/** Слот инвентаря хотбара (36–44) → quickBar (0–8). 36→0, 37→1, … 44→8 */
function hotbarSlotToQuick(slot) {
    return slot - firstHotbarSlot;
}

/** quickBar (0–8) → слот инвентаря (36–44) */
function quickToHotbarSlot(quick) {
    return firstHotbarSlot + quick;
}

const analysisAH = 'Анализ аукциона';
const myItems = 'Хранилище';
const rtp = 'RTP';
const accept = 'подтверждение покупки';

const LOBBY_IGNORE_MS = 60_000;
const LOBBY_BROADCAST_MARKERS = [
    '⚡ Наша группа ВК vk.com/funtime',
    '⚡ Наш Телеграм t.me/funtime',
    '⚡ Наш Дискорд dd.FunTime.su',
    '⚡ Наш Сайт FunTime.su',
    '⚡ Наши сообщества и соц. сети /links',
    '⚡ Вы играете на FunTime! play.funtime.su',
];

const ANSI = {
    reset: '\x1b[0m',
    dim: '\x1b[2m',
    bold: '\x1b[1m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
};

let botWorkerStartTime = Date.now();

function logTag() {
    return `${ANSI.cyan}[${config.username}]${ANSI.reset}`;
}

function logChat(raw) {
    console.log(`${ANSI.dim}${logTag()} 💬 ${raw}${ANSI.reset}`);
}

function logInfo(msg) {
    console.log(`${logTag()} ${ANSI.bold}ℹ${ANSI.reset} ${msg}`);
}

function logOk(msg) {
    console.log(`${logTag()} ${ANSI.green}✓${ANSI.reset} ${msg}`);
}

function logWarn(msg) {
    console.log(`${logTag()} ${ANSI.yellow}⚡${ANSI.reset} ${msg}`);
}

function logAfk(msg) {
    console.log(`${logTag()} ${ANSI.red}${ANSI.bold}AFK${ANSI.reset} ${ANSI.red}${msg}${ANSI.reset}`);
}

function isLobbyBroadcastMessage(text) {
    return LOBBY_BROADCAST_MARKERS.some((marker) => text.includes(marker));
}

const config = {
    username: workerData.username,
    password: workerData.password,
    anarchy: workerData.anarchy,
    type: workerData.type,
    item: workerData.item,
    goType: workerData.goType,
    timeJoinAnarchy: 0,
    lastWarpTime: 0,
    enoughItems: false,
    items: workerData.itemPrices ?? [],
    needSell: false,
    walkTime: 0,
    BuyingItem: { id: '', price: 0 },
    needPrice: 0,
    key: '',
    menu: analysisAH,
    lastResetTime: Date.now(),
    botUpdateWindow: false,
    botStartClickTime: 0,
    afk: false,
    needRTP: false,
    hasDangerousTrash: false,
    needReloadAH: false,
    balance: null,
    needSendAH: true,
};

var bot = null;
/** UUID лотов, которые уже кликают / в очереди (с оркестратора) */
let itemsBuying = [];
/** Позиция с сервера (обновляется только на forcedMove / entityMoved своего бота). */
let serverPosition = null;

function syncServerPosition() {
    if (bot?.entity?.position) {
        serverPosition = bot.entity.position.clone();
    }
}

/** Клон последней серверной позиции; если ещё не было пакета — текущая entity. */
function getServerPosition() {
    if (serverPosition) return serverPosition.clone();
    if (bot?.entity?.position) return bot.entity.position.clone();
    return null;
}

function attachServerPositionTracking() {
    bot.on('forcedMove', syncServerPosition);
    bot.on('entityMoved', (entity) => {
        if (entity === bot.entity) syncServerPosition();
    });
}

function markAnarchyJoined() {
    config.timeJoinAnarchy = Date.now();
    logOk(`анархия ${config.anarchy} — вход`);
    parentPort.postMessage({ name: 'success', username: config.username });
    logOk(`на анархии an${config.anarchy} → success`);
}

function reportError(where, err) {
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    const text = `${config.username} — ${where}: ${detail}`;
    console.error(`${logTag()} ${ANSI.red}✖${ANSI.reset} ${ANSI.red}${where}${ANSI.reset}: ${detail}`);
    parentPort.postMessage(text);
}

/** Новый ключ сессии кликов по АХ (если окно обновилось — старые клики не выполняются) */
function generateKey() {
    config.key = Math.random().toString(36).substring(2, 15);
    return config.key;
}

function delayMs(range) {
    if (typeof range === 'number') return range;
    return Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeClickBuy(bot, slot, time, key) {
    let timeDelay = time;
    if (config.botUpdateWindow) {
        config.botUpdateWindow = false;
        config.botStartClickTime = Date.now();
    } else {
        timeDelay = time - (Date.now() - config.botStartClickTime);
        if (timeDelay <= 0) timeDelay = 0;
    }

    await sleep(timeDelay);
    if (config.key !== key) {
        logWarn(`клик слот ${slot} отменён (новое окно)`);
        return;
    }

    config.botUpdateWindow = true;
    if (bot.currentWindow) {
        logInfo(`клик слот ${slot}`);
        await bot.clickWindow(slot, leftMouseButton, shiftClick);
    } else {
        logWarn(`клик слот ${slot} — окна нет`);
    }
}

function getSlotInfoSafe(item, slotIndex) {
    try {
        return getSlotInfo(item, config.items, config.goType);
    } catch (err) {
        reportError(`getSlotInfo slot=${slotIndex}`, err);
        return null;
    }
}

function parseChatPrice(text) {
    return parseInt(text.replace(/\./g, '').replace(/\D/g, ''), 10);
}

function getIdBySellPrice(price) {
    if (!Number.isFinite(price)) return '';
    const found = config.items.find((item) => item.priceSell % 100 === price % 100);
    return found?.id ?? '';
}

/** Сумма 5× самого дорогого предмета из каталога бота (priceSell, goType). */
function getSaveSum() {
    if (!Array.isArray(config.items) || !config.items.length) return null;

    let bestPrice = 0;
    for (const entry of config.items) {
        if (!entry?.id?.endsWith('1.21')) continue;
        if (config.goType && entry.type !== config.goType) continue;

        const unitPrice = entry.priceSell;
        if (typeof unitPrice !== 'number' || !Number.isFinite(unitPrice) || unitPrice <= 0) continue;

        if (unitPrice > bestPrice) bestPrice = unitPrice;
    }

    if (!bestPrice) return null;
    return bestPrice * 5;
}

function getHeldItemInfo() {
    if (!bot) return null;
    const slot = quickToHotbarSlot(bot.quickBarSlot);
    return getSlotInfoSafe(bot.inventory.slots[slot], slot);
}

async function handleChatMessage(text) {
    if (text.includes('[✔] Предметы успешно перевыставлены!')) {
        config.lastResetTime = Date.now();
        return;
    }
    if (text.includes('[☃] Вы успешно купили')) {
        const price = parseChatPrice(text);
        const id = config.BuyingItem.id;
        parentPort.postMessage({ name: 'buy', id, price });
        config.needSell = true;
        return;
    }

    if (text.includes('[☃] У Вас купили')) {
        const price = parseChatPrice(text);
        parentPort.postMessage({ name: 'sell', id: getIdBySellPrice(price), price });
        config.needSell = true;
        return;
    }
    if (text.includes('[☃] Не удалось выставить') ||
        text.includes('[✘] Ошибка! У Вас переполнено Хранилище!')) {
        config.enoughItems = true;
        return;
    }
    if (text.includes('Данная команда недоступна в режиме AFK')) {
        config.afk = true;
        logAfk('сервер: команда недоступна в режиме AFK');
        return;
    }
    if (text.includes('[❌] Вы не можете выкидывать этот предмет в этом месте!')) {
        config.hasDangerousTrash = true;
        config.needRTP = true;
        return;
    }

    if (text.includes('[☃] Максимальная цена')) {
        const balance = parseChatPrice(text);
        const info = getHeldItemInfo();
        if (!info?.id || !info.sellPrice) {
            reportError('maxPrice', 'нет предмета в руке или sellPrice');
            return;
        }
        const basePrice = Math.floor(balance / 10000) * 10000;
        const marker = info.sellPrice % 100;
        let finalPrice = basePrice + marker;
        if (finalPrice > balance) finalPrice = basePrice - 100 + marker;
        config.needPrice = finalPrice;
        parentPort.postMessage({ name: 'set_max_price', type: info.id, price: finalPrice });
        return;
    }

    if (text.includes('[☃] Минимальная цена')) {
        const balance = parseChatPrice(text);
        const info = getHeldItemInfo();
        if (!info?.id || !info.sellPrice) return;

        const basePrice = Math.ceil(balance / 10000) * 10000;
        const marker = info.sellPrice % 100;
        const finalPrice = basePrice + marker + (info.nacenka ?? 0);
        config.needPrice = finalPrice;

        if (text.includes('круш')) {
            return;
        }

        parentPort.postMessage({ name: 'set_min_price', type: info.id, price: finalPrice });
        return;
    }

    if (text.includes('BotFilter >> Введите номер с картинки в чат')) {
        parentPort.postMessage(`${workerData.username} - ввести капчу`);
        return;
    }

    if (text.includes('вы забанены')) {
        parentPort.postMessage({ name: 'banned' });
        return;
    }
    if (text.includes('Отключите VPN и Proxy и повторите попытку входа')) {
        parentPort.postMessage(`${workerData.username} - vpn спалили`);
        return;
    }
    if (text.includes('Не так быстро..') || text.includes('[✘] Ошибка! Этот товар уже Купили!')) {
        config.needReloadAH = true;
        return;
    }
    if (text.includes('[$] Ваш баланс:')) {
        config.balance = parseChatPrice(text);
        return;
    }
    if (isLobbyBroadcastMessage(text)) {
        if (Date.now() - botWorkerStartTime < LOBBY_IGNORE_MS) return;
        const preview = text.trim().length > 50 ? `${text.trim().slice(0, 50)}…` : text.trim();
        logWarn(`лобби «${preview}» → sellItems`);
        config.timeJoinAnarchy = 0;
        await sellItems();
        return;
    }
}

parentPort.on('message', (data) => {
    if (data.type === 'price') config.items = data.data;
    if (data.type === 'items_buying') itemsBuying = data.data ?? [];
});

function main() {
    bot = mineflayer.createBot({
        host: 'mc.funtime.su',
        port: 25565,
        username: config.username,
        password: config.password,
        version: '1.21.8',
        chatLengthLimit: 256,
    });
    attachServerPositionTracking();

    bot.on('error', (err) => {
        parentPort.postMessage(JSON.stringify(err));
        console.error(`${logTag()} ${ANSI.red}⛔ end${ANSI.reset}: ${JSON.stringify(err)}`);
        process.exit(1);
    });
    bot.on('scoreboardCreated', (scoreboard) => {
        if (JSON.stringify(scoreboard).includes(`${config.anarchy}`)) {
            markAnarchyJoined();
        }
    });
    bot.on('message', async (message) => {
        const text = message.toString();
        logChat(text);
        if (text.includes('[⚝] Телепортация!')) {
            config.lastWarpTime = Date.now();
            logInfo('телепортация варпа');
            return;
        }
        await handleChatMessage(text);
    });

    bot.on('resourcePack', (_url, hash) => {
        if (bot._client) {
            bot._client.write('resource_pack_receive', { uuid: hash.ascii, result: 0 });
        }
    });

    bot.on('kicked', (reason) => {
        console.error(`${logTag()} ${ANSI.red}⛔ kicked${ANSI.reset}: ${JSON.stringify(reason)}`);
        process.exit(1);
    });

    bot.once('spawn', async () => {
        syncServerPosition();
        botWorkerStartTime = Date.now();
        logOk('spawn → /l → sellItems → safeAH');
        await rnd('BASE_DELAY');
        bot.chat(`/l ${config.password}`);
        config.timeJoinAnarchy = 0;
        await sellItems();
        await safeAH();
    });

    bot.on('windowOpen', async () => {
        // if (bot.currentWindow) {
        //     const { slots, ...winWithoutSlots } = bot.currentWindow;
        //     console.log(JSON.stringify({ ...winWithoutSlots, slotsCount: slots?.length ?? 0 }));
        // }
        const key = generateKey();
        logInfo(`windowOpen → key …${String(key).slice(-6)}`);
        const { slots: _windowSlots, ...windowWithoutSlots } = bot.currentWindow ?? {};
        const windowJSON = JSON.stringify(windowWithoutSlots).toLowerCase();

        if (windowJSON.includes('хранилище')) {
            config.menu = myItems;
        } else if (windowJSON.includes('телепортации')) {
            config.menu = rtp;
        } else if (windowJSON.includes('подтверждение покупки')) {
            config.menu = accept;
        } else {
            config.menu = analysisAH;
        }
        logInfo(`окно: ${config.menu}`);

        switch (config.menu) {
            case analysisAH:
                if (config.walkTime < Date.now() - 55000 ||
                    (config.needSell && !config.enoughItems && hasBotItem())) {
                    logInfo('АХ → sellItems (прогулка/needSell)');
                    await sellItems();
                    if (!config.hasDangerousTrash) await safeAH();
                    break;
                }

                if (config.lastResetTime < Date.now() - 60000 || config.enoughItems) {
                    logInfo('АХ → хранилище (reset/enoughItems)');
                    config.menu = myItems;
                    await safeClickBuy(bot, slotToStorage, delayMs({ min: 1500, max: 4500 }), key);
                    break;
                }

                const slotToBuy = await getBestAHSlot();
                if (slotToBuy === null || config.needReloadAH) {
                    if (config.needReloadAH) config.needReloadAH = false;
                    logInfo(`АХ → reload 49 (лот=${slotToBuy}, needReload=${config.needReloadAH})`);
                    await safeClickBuy(bot, slotToReloadAH, delayMs({ min: 1500, max: 4500 }), key);
                } else if (slotToBuy < 9) {
                    logInfo(`АХ → купить слот ${slotToBuy}`);
                    await safeClickBuy(bot, slotToBuy, delayMs({ min: 500, max: 700 }) * (slotToBuy + 2), key);
                } else {
                    logInfo(`АХ → reload 49 (слот ${slotToBuy} вне диапазона)`);
                    await safeClickBuy(bot, slotToReloadAH, delayMs({ min: 1500, max: 4500 }), key);
                }

                break;

            case myItems:
                if (!bot.currentWindow?.slots[0]) {
                    config.enoughItems = false;
                }
                if (config.needSendAH) {
                    const botAh = [];
                    for (let i = 0; i < STORAGE_AH_SLOTS; i++) {
                        const currentSlot = bot.currentWindow?.slots[i];
                        if (currentSlot) {
                            const itemCfg = findMatchingConfigItem(currentSlot, config.items, config.goType);
                            if (itemCfg?.id) botAh.push(itemCfg.id);
                        } else break;
                    }

                    parentPort.postMessage({ name: 'items', username: config.username, items: botAh });
                    config.needSendAH = false;

                    const inv = [];
                    for (let i = 0; i <= lastInventorySlot; i++) {
                        const slotData = bot.inventory.slots[i];
                        if (!slotData) continue;

                        const itemCfg = findMatchingConfigItem(slotData, config.items, config.goType);
                        if (itemCfg?.id) inv.push(itemCfg.id);
                    }
                    parentPort.postMessage({ name: 'inventory', data: inv, username: config.username });
                }
                if (config.lastResetTime < Date.now() - 60000) {
                    if (bot.currentWindow?.slots[0]) {
                        logInfo('хранилище → сброс (клик 52)');
                        config.menu = myItems;
                        await safeClickBuy(bot, 52, delayMs({ min: 1500, max: 4500 }), key);
                        while (config.lastResetTime < Date.now() - 60000) await rnd('POLL');
                    } else {
                        config.lastResetTime = Date.now();
                    }
                }

                let unlistSlot = null;
                for (let i = 4; i >= 0; i--) {
                    const currentSlot = bot.currentWindow?.slots[i];
                    if (!currentSlot) continue;

                    const priceOnAH = getPriceFromAhItem(currentSlot);
                    const info = getSlotInfoSafe(currentSlot, i);
                    if (!info?.sellPrice) continue;

                    if (info.sellPrice !== priceOnAH || config.enoughItems) {
                        unlistSlot = i;
                        break;
                    }
                }

                if (unlistSlot !== null) {
                    logInfo(`хранилище → снять лот слот ${unlistSlot}`);
                    config.needSell = true;
                    config.menu = myItems;
                    await safeClickBuy(bot, unlistSlot, delayMs({ min: 1500, max: 3500 }), key);
                    break;
                }

                if (config.needSell && hasBotItem()) {
                    logInfo('хранилище → sellItems');
                    await sellItems();
                    await safeAH();
                } else {
                    logInfo('хранилище → назад в АХ');
                    config.menu = analysisAH;
                    await safeClickBuy(bot, slotToStorage, delayMs({ min: 1500, max: 4500 }), key);
                }
                break;

            case rtp:
                await safeClickBuy(bot, 0, delayMs({ min: 1000, max: 3000 }), key);
                config.needRTP = false;
                config.hasDangerousTrash = false;
                config.lastWarpTime = Date.now();
                await sellItems();
                await safeAH();
                break;
              
            case accept:
                logInfo('окно → подтверждение покупки (клик glass)');
                await safeClickBuy(bot, slotGlass, delayMs({ min: 400, max: 1000 }), key);
                break;
        }
        await rnd('WINDOW_DELAY');
        if (key === config.key) {
            logInfo('windowOpen → конец (key не изменился)');
            if (config.menu === analysisAH) {
                await safeClickBuy(bot, slotToReloadAH, delayMs({ min: 1500, max: 4500 }), key);
            }
            return;
        }
        logInfo(`windowOpen → конец (${config.menu})`);
    });
}

main();

async function joinAnarchy() {
    if (config.timeJoinAnarchy) await rnd('ANARCHY_DELAY');
    while (!config.timeJoinAnarchy) {
        await rnd('BASE_DELAY');
        logInfo(`/an${config.anarchy}… (жду входа)`);
        bot.chat(`/an${config.anarchy}`);
        await rnd('ANARCHY_DELAY');
    }
    const waitMs = config.timeJoinAnarchy + 11000 - Date.now();
    if (waitMs > 0) logInfo(`joinAnarchy → пауза ${Math.ceil(waitMs / 1000)}с`);
    while (Date.now() < config.timeJoinAnarchy + 11000) await rnd('POLL');
}

async function waitWarpTeleport() {
    while (Date.now() - config.lastWarpTime < 7100) await rnd('POLL');
}

/** Выброс мусора в слоте. true = ушли на RTP (нужно прервать sellItems). */
async function tossTrashAtSlot(slot) {
    while (true) {
        const item = bot.inventory.slots[slot];
        const info = getSlotInfoSafe(item, slot);
        if (!info?.isTrash || !item) return false;

        if (config.needRTP) {
            config.needRTP = false;
            await rnd('BASE_DELAY');
            await waitWarpTeleport();
            config.menu = rtp;
            bot.chat('/rtp');
            return true;
        }

        try {
            await rnd('BASE_DELAY');
            await bot.tossStack(item);
            await rnd('POLL');
        } catch (err) {
            reportError(`tossTrashAtSlot slot=${slot}`, err);
        }
    }
}

function getRandomElement(array) {
    if (!Array.isArray(array) || array.length === 0) {
        throw new Error("Input must be a non-empty array");
    }
    return array[Math.floor(Math.random() * array.length)];
}

async function sellItems() {
    logOk('продажа → старт');
    try {
        config.needSell = false;
        config.needSendAH = true;
        await joinAnarchy();
        let canSell = true;

        if (!bot) {
            reportError('sellItems', 'bot не создан');
            canSell = false;
        } else if (!Array.isArray(config.items)) {
            reportError('sellItems', 'config.items не массив');
            canSell = false;
        } else if (!config.items.length) {
            reportError('sellItems', 'каталог пуст — жди price от оркестратора');
            canSell = false;
        }

        if (!canSell) logWarn('продажа → пропуск (нет бота или каталога)');

        if (bot) {
            if (bot.currentWindow) {
                await rnd('BASE_DELAY');
                await bot.closeWindow(bot.currentWindow);
            }
            if (config.lastWarpTime < Date.now() - 120000) {
                const warp = warps[Math.floor(Math.random() * warps.length)];
                await rnd('BASE_DELAY');
                bot.chat(`/warp ${warp}`);
            }

            if (canSell) {
                await dropTrash();
            }

            await walk();
        }

        if (canSell) {
            await moveToHotBar();

            let currentSlot = firstHotbarSlot;
            while (hasBotItem() && !config.enoughItems && currentSlot <= lastHotbarSlot && !config.hasDangerousTrash) {
                await joinAnarchy();
                if (currentSlot > lastHotbarSlot) {
                    currentSlot = firstHotbarSlot;
                    continue;
                }

                const item = bot.inventory.slots[currentSlot];
                const info = getSlotInfoSafe(item, currentSlot);

                if (info?.isTrash && item) {
                    if (await tossTrashAtSlot(currentSlot)) {
                        return;
                    }
                    continue;
                }

                if (!info || !item) {
                    currentSlot++;
                    continue;
                }

                if (!info.sellPrice) {
                    reportError(`sellItems slot=${currentSlot}`, 'нет sellPrice');
                    currentSlot++;
                    continue;
                }

                try {
                    const quick = hotbarSlotToQuick(currentSlot);
                    if (bot.quickBarSlot !== quick) {
                        await rnd('HOTBAR_DELAY');
                        await bot.setQuickBarSlot(quick);
                    }
                    await antiAfkIfNeeded();
                    await rnd('BASE_DELAY');
                    if (config.needPrice) {
                        bot.chat(`/ah sell ${config.needPrice}`);
                        config.needPrice = 0;
                    } else {
                        bot.chat(`/ah sell ${info.sellPrice}`);
                    }
                    await rnd('POLL');
                } catch (err) {
                    reportError(`sellItems ah sell slot=${currentSlot}`, err);
                    currentSlot++;
                }
            }
            if (!config.hasDangerousTrash) {
                await safeBalance();
                const saveSum = getSaveSum();
                if (saveSum != null && config.balance != null && config.balance > saveSum) {
                    const investSum = config.balance - saveSum;
                    if (investSum > 5_000_000) {
                        await rnd('AH_CMD');
                        bot.chat(`/clan invest ${investSum}`);
                    }
                }
            }
        }

    } catch (err) {
        reportError('sellItems', err);
        await waitWarpTeleport();
    } finally {
        await waitWarpTeleport();
        logOk('продажа → конец');
    }
}

async function moveToHotBar() {
    if (config.hasDangerousTrash) return;
    try {
        for (let slot = firstHotbarSlot; slot <= lastHotbarSlot; slot++) {
            const stack = bot.inventory.slots[slot];
            const info = getSlotInfoSafe(stack, slot);

            if (info?.isTrash && stack) {
                if (await tossTrashAtSlot(slot)) return;
                continue;
            }

            if (info && !info.isTrash) continue;

            for (let src = firstInventorySlot; src <= lastInventorySlot; src++) {
                const invStack = bot.inventory.slots[src];
                const invInfo = getSlotInfoSafe(invStack, src);
                if (invInfo && !invInfo.isTrash) {
                    try {
                        await rnd('BASE_DELAY');
                        await bot.moveSlotItem(src, slot);
                    } catch (err) {
                        reportError(`moveToHotBar move ${src}->${slot}`, err);
                    }
                    break;
                }
            }
        }
    } catch (err) {
        reportError('moveToHotBar', err);
    }
}

function hasBotItem() {
    try {
        for (let i = firstInventorySlot; i <= lastHotbarSlot; i++) {
            const info = getSlotInfoSafe(bot.inventory.slots[i], i);
            if (info && !info.isTrash) return true;
        }
        return false;
    } catch (err) {
        reportError('hasBotItem', err);
        return false;
    }
}

const WALK_DIR_TIMEOUT_MS = 2000;
const WALK_MAX_MS = 20_000;

function pickMoveKey(exclude = null) {
    const pool = exclude ? moves.filter((m) => m !== exclude) : moves;
    return getRandomElement(pool.length ? pool : moves);
}

/** Движение, пока серверная позиция не сместится на 0.8–1.2 блока; раз в 2 с — другая сторона. */
async function walk() {
    const walkStart = getServerPosition();
    if (!walkStart) {
        logWarn('ходьба: нет серверной позиции');
        return;
    }

    const needDist = 0.8 + Math.random() * 0.4;
    const walkStartedAt = Date.now();
    logInfo(
        `ХОДЬБА - СТАРТ @ ${walkStart.x.toFixed(1)} ${walkStart.y.toFixed(1)} ${walkStart.z.toFixed(1)} (нужно ${needDist.toFixed(2)} блок.)`
    );

    let lastKey = null;

    try {
        while (getServerPosition().distanceTo(walkStart) < needDist) {
            if (Date.now() - walkStartedAt > WALK_MAX_MS) {
                logWarn(`ходьба: таймаут ${WALK_MAX_MS / 1000}с`);
                break;
            }

            const key = pickMoveKey(lastKey);
            lastKey = key;
            const dirStartedAt = Date.now();

            bot.clearControlStates();
            bot.setControlState(key, true);
            bot.setControlState('sprint', true);

            while (getServerPosition().distanceTo(walkStart) < needDist) {
                if (Date.now() - walkStartedAt > WALK_MAX_MS) break;
                await bot.waitForTicks(1);

                if (Date.now() - dirStartedAt >= WALK_DIR_TIMEOUT_MS) {
                    break;
                }
            }

            bot.clearControlStates();
        }
    } finally {
        bot.clearControlStates();
    }

    const walkEnd = getServerPosition();
    const elapsedSec = (Date.now() - walkStartedAt) / 1000;
    const serverDist = walkEnd.distanceTo(walkStart);
    logOk(
        `ХОДЬБА - КОНЕЦ ${elapsedSec.toFixed(1)}с @ ${walkEnd.x.toFixed(1)} ${walkEnd.y.toFixed(1)} ${walkEnd.z.toFixed(1)} | ` +
        `прошёл ${serverDist.toFixed(2)} из ${needDist.toFixed(2)} блок.`
    );
    config.walkTime = Date.now();
}

async function antiAfkIfNeeded() {
    if (config.afk) {
        logAfk('сходу с AFK → ходьба');
        config.afk = false;
        await walk();
    }
}

/** Пока ключ не сменился (открылось окно АХ) — одно движение и `/ah search`. */
async function safeAH() {
    logOk('safeAH → старт');
    if (!bot) return;
    if (bot.currentWindow) {
        logInfo('safeAH → закрываю окно');
        await rnd('BASE_DELAY');
        await bot.closeWindow(bot.currentWindow);
    }
    await joinAnarchy();
    await rnd('BASE_DELAY');

    config.needReloadAH = true;
    config.menu = analysisAH;
    config.botUpdateWindow = true;
    const key = config.key;

    let searchCount = 0;
    while (key === config.key) {
        if (config.afk) logAfk('режим AFK (safeAH)');
        searchCount++;
        logInfo(`safeAH → /ah search #${searchCount} (${config.item})`);
        await rnd('AH_CMD');
        await antiAfkIfNeeded();
        config.menu = analysisAH;
        bot.chat(`/ah search ${config.item}`);
        await rnd('AH_CMD');
    }
    logOk(`safeAH → выход после ${searchCount} search (открылось окно)`);
}
async function safeBalance() {
    if (!bot) return;
    config.balance = null;
    if (bot.currentWindow) {
        await rnd('BASE_DELAY');
        await bot.closeWindow(bot.currentWindow);
    }
    await joinAnarchy();
    await rnd('BASE_DELAY');

    config.botUpdateWindow = true;

    while (config.balance === null) {
        await antiAfkIfNeeded();
        await rnd('AH_CMD');
        config.menu = analysisAH;
        bot.chat(`/balance`);
        await rnd('POLL');
    }
}


/**
 * Лучший слот на аукционе для покупки (0–17).
 * Ставит config.BuyingItem, шлёт buying с UUID, возвращает номер слота или null.
 */
async function getBestAHSlot() {
    try {
        if (!bot?.currentWindow?.slots) return null;

        for (let slot = firstAHSlot; slot <= lastAHSlot; slot++) {
            const slotData = bot.currentWindow.slots[slot];
            if (!slotData) continue;

            let currentUUID = null;
            try {
                currentUUID = getItemUUID(slotData);
            } catch (err) {
                reportError(`getItemUUID slot=${slot}`, err);
                continue;
            }

            if (currentUUID && itemsBuying.includes(currentUUID)) continue;

            const info = getSlotInfoSafe(slotData, slot);
            if (!info || info.isTrash || !info.id || !info.buyPrice) continue;

            let ahPrice;
            try {
                ahPrice = getPriceFromAhItem(slotData);
            } catch (err) {
                reportError(`getPriceFromAh slot=${slot}`, err);
                continue;
            }

            if (ahPrice >= info.buyPrice) continue;

            config.BuyingItem.id = info.id;
            config.BuyingItem.price = ahPrice;

            if (currentUUID) {
                parentPort.postMessage({ name: 'buying', data: currentUUID });
            }

            return slot;
        }

        return null;
    } catch (err) {
        reportError('getBestAHSlot', err);
        return null;
    }
}

async function dropTrash() {
    try {
        for (let i = firstInventorySlot; i <= lastHotbarSlot; i++) {
            const item = bot.inventory.slots[i];
            const info = getSlotInfoSafe(item, i);
            if (!info?.isTrash || !item) continue;
            if (await tossTrashAtSlot(i)) return;
        }
    } catch (err) {
        reportError('dropTrash', err);
    }
}