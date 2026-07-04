import fs from 'fs'
import mineflayer from 'mineflayer';
import { workerData, parentPort } from 'worker_threads';
import { rnd } from './delay/delay.mjs';
import net from 'net';
import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import prismarineChat from 'prismarine-chat';

const ChatMessage = prismarineChat('1.21.4');

import {
    getSlotInfo,
    getItemUUID,
    getPriceFromAhItem,
    findMatchingConfigItem,
    getDurabilityPercent,
} from './items/slotInfo.mjs';
import {
    isUuidBlockedByOther,
    mergeBuyingClaim,
} from './items-buying-coord.mjs';

process.on('uncaughtException', (err) => {
    if (isIgnorableProtocolNoise(err)) return;
    console.error('UNCAUGHT EXCEPTION');
    console.error(err);
});

process.on('unhandledRejection', (err) => {
    if (isIgnorableProtocolNoise(err)) return;
    console.error('UNHANDLED REJECTION');
    console.error(err);
});

/** Funtime шлёт кастомные particle-пакеты — protodef не парсит, бот при этом жив. */
function isIgnorableProtocolNoise(err) {
    if (!err) return false;
    const name = err.name ?? '';
    const stack = String(err.stack ?? '');
    const msg = String(err.message ?? err);
    if (name === 'PartialReadError' || msg.includes('PartialReadError')) return true;
    if (stack.includes('packet_world_particles')) return true;
    if (stack.includes('loadDimensionCodec') || stack.includes('prismarine-nbt/nbt.js')) return true;
    if (stack.includes('handleRespawnPacketData')) return true;
    if (stack.includes('prismarine-chat') || stack.includes('ChatMessage.fromNetwork')) return true;
    if (msg.includes('Cannot convert undefined or null to object')) return true;
    if (msg.includes('uncompressed length') || msg.includes('problem inflating chunk')) return true;
    if (msg.includes('client timed out')) return true;
    if (msg.includes("reading 'translate'")) return true;
    return false;
}

function flattenChatFallback(raw) {
    if (raw == null) return '';
    if (typeof raw === 'string') {
        try {
            return flattenChatFallback(JSON.parse(raw));
        } catch {
            return raw;
        }
    }
    if (typeof raw !== 'object') return String(raw);
    let out = raw.text ?? '';
    if (Array.isArray(raw.extra)) {
        for (const part of raw.extra) out += flattenChatFallback(part);
    }
    if (raw.translate && Array.isArray(raw.with)) {
        for (const part of raw.with) out += flattenChatFallback(part);
    }
    return out;
}

function chatTextFromFormatted(raw) {
    if (raw == null || raw === '') return '';
    try {
        return ChatMessage.fromNotch(raw).toString();
    } catch {
        return flattenChatFallback(raw);
    }
}

function chatTextFromRaw(data) {
    if (data?.plainMessage) return String(data.plainMessage);
    return chatTextFromFormatted(
        data?.formattedMessage ?? data?.content ?? data?.unsignedContent,
    );
}

function formatWindowTitle(win) {
    if (!win) return '?';
    const raw = win.title;
    if (raw == null || raw === '') return '(пусто)';
    try {
        if (typeof raw === 'string') {
            return chatTextFromFormatted(raw) || raw;
        }
        if (typeof raw.toString === 'function') {
            const text = raw.toString();
            if (text && text !== '[object Object]') return text;
        }
        if (typeof raw === 'object') {
            return chatTextFromFormatted(raw) || flattenChatFallback(raw) || JSON.stringify(raw);
        }
    } catch {
        return String(raw);
    }
    return String(raw);
}

function jsonFull(value) {
    try {
        return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
    } catch (err) {
        return `[json err: ${err.message}] ${String(value)}`;
    }
}

function serializeWindowNoSlots(win) {
    if (!win) return null;
    let title = win.title;
    if (title && typeof title.toJSON === 'function') {
        try {
            title = title.toJSON();
        } catch { /* raw title */ }
    }
    return {
        id: win.id,
        type: win.type,
        title,
        slotsCount: win.slots?.length ?? 0,
        inventoryStart: win.inventoryStart,
        inventoryEnd: win.inventoryEnd,
        hotbarStart: win.hotbarStart,
        craftingResultSlot: win.craftingResultSlot,
        requiresConfirmation: win.requiresConfirmation,
        selectedItem: win.selectedItem,
    };
}

function logWindowDebug(win) {
    if (!win) return;
    const font = getWindowTitleFont(win.title);
    logInfo(`окно font: ${font ?? '(нет)'}`);
    logInfo(`окно FULL (no slots): ${jsonFull(serializeWindowNoSlots(win))}`);
}

/** Funtime: title в NBT, тип окна в поле font (minecraft:rtp, …). */
function nbtLeafString(node) {
    if (node == null) return null;
    if (typeof node === 'string') return node;
    if (node.type === 'string' && node.value != null) return String(node.value);
    if (typeof node.value === 'string') return node.value;
    return null;
}

function getWindowTitleFont(title) {
    if (title == null) return null;
    let raw = title;
    if (typeof title.toJSON === 'function') {
        try {
            raw = title.toJSON();
        } catch { /* raw title */ }
    }
    if (raw?.type === 'compound' && raw.value) {
        raw = raw.value;
    }
    const fontNode = raw?.font;
    if (fontNode == null) return null;
    return nbtLeafString(fontNode);
}

function resolveWindowMenu(win) {
    const font = getWindowTitleFont(win?.title);
    if (font?.includes('rtp')) return rtp;

    const { slots: _windowSlots, ...windowWithoutSlots } = win ?? {};
    const windowJSON = JSON.stringify(windowWithoutSlots).toLowerCase();

    if (windowJSON.includes('клан')) return clan;
    if (windowJSON.includes('хранилище')) return myItems;
    if (windowJSON.includes('телепорт') || windowJSON.includes('телепортации')) return rtp;
    if (windowJSON.includes('подозрительная цена') ||
        windowJSON.includes('подтверждение покупки')) {
        return accept;
    }
    return analysisAH;
}

function setupWindowDebugLog(bot) {
    bot._client.prependListener('open_window', (packet) => {
        logInfo(`open_window FULL (no slots): ${jsonFull(packet)}`);
    });
}

/** Funtime: chat_type в registry битый — не используем ChatMessage.fromNetwork. */
function setupChatSafeGuard(bot) {
    const client = bot._client;
    if (!client) return;

    client.removeAllListeners('playerChat');
    client.removeAllListeners('systemChat');

    client.on('playerChat', (data) => {
        const text = chatTextFromRaw(data);
        if (text) void onBotChatText(text);
    });

    client.on('systemChat', (data) => {
        const text = chatTextFromRaw(data);
        if (text) void onBotChatText(text);
    });
}

/** Funtime: registry_data кривой — без dimensionsArray падает login/respawn. */
function ensureRegistryDimensionStub(bot) {
    if (Array.isArray(bot.registry.dimensionsArray) && bot.registry.dimensionsArray.length > 0) {
        return;
    }
    const fallback = { name: 'minecraft:overworld', minY: -64, height: 384 };
    bot.registry.dimensionsArray = Array.from({ length: 16 }, () => fallback);
    bot.registry.dimensionsByName ??= { overworld: fallback };
}

/** Play-пакеты, которые нельзя слать в configuration phase (transfer /anXXX). */
const CONFIG_BLOCKED_PACKETS = new Set([
    'position', 'look', 'position_look', 'flying',
    'chat', 'chat_command', 'chat_command_signed', 'chat_message',
    'window_click', 'close_window',
    'arm_animation', 'entity_action',
    'held_item_slot', 'set_creative_slot',
]);

/** Funtime/Bungee transfer: не слать gameplay-пакеты + ответы на configuration. */
let configTransferStartedAt = 0;

function setupConfigurationTransferFix(bot) {
    const client = bot._client;
    if (!client) return;

    const origLoadDimensionCodec = bot.registry.loadDimensionCodec.bind(bot.registry);
    bot.registry.loadDimensionCodec = (codec) => {
        try {
            origLoadDimensionCodec(codec);
        } catch {
            ensureRegistryDimensionStub(bot);
        }
    };

    client.prependListener('login', () => ensureRegistryDimensionStub(bot));
    client.prependListener('respawn', () => ensureRegistryDimensionStub(bot));

    const PACK_ACCEPTED = 3;
    const PACK_LOADED = 0;
    let blockSelectKnownPacksWrite = false;

    const origWrite = client.write.bind(client);
    client.write = (name, params) => {
        if (client.state === 'configuration' && CONFIG_BLOCKED_PACKETS.has(name)) {
            return;
        }
        if (blockSelectKnownPacksWrite && name === 'select_known_packs') {
            return;
        }
        return origWrite(name, params);
    };

    client.on('start_configuration', () => {
        configTransferStartedAt = Date.now();
        blockSelectKnownPacksWrite = false;
        bot.physicsEnabled = false;
        logInfo('transfer → configuration phase (жду finish_configuration)');
    });

    client.on('finish_configuration', () => {
        configTransferStartedAt = 0;
        blockSelectKnownPacksWrite = false;
        bot.physicsEnabled = true;
        logOk('transfer → configuration завершён');
    });

    client.on('cookie_request', (data) => {
        if (client.state !== 'configuration') return;
        logInfo(`config → cookie_request: ${data.cookie}`);
        origWrite('cookie_response', { key: data.cookie });
    });

    client.prependListener('add_resource_pack', (data) => {
        if (client.state !== 'configuration') return;
        logInfo('config → add_resource_pack, принимаю');
        origWrite('resource_pack_receive', { uuid: data.uuid, result: PACK_ACCEPTED });
        origWrite('resource_pack_receive', { uuid: data.uuid, result: PACK_LOADED });
    });

    client.prependListener('select_known_packs', (data) => {
        if (client.state !== 'configuration') return;
        const packs = (data.packs ?? []).map((p) => ({
            namespace: p.namespace,
            id: p.id,
            version: p.version,
        }));
        logInfo(`config → select_known_packs (${packs.length})`);
        origWrite('select_known_packs', { packs });
        blockSelectKnownPacksWrite = true;
    });

    client.on('disconnect', (data) => {
        if (client.state !== 'configuration') return;
        logWarn(`config → disconnect: ${JSON.stringify(data.reason ?? data)}`);
    });

    bot.on('resourcePack', () => {
        if (client.state === 'configuration') return;
        bot.acceptResourcePack();
    });
}

function isInConfigurationTransfer() {
    return bot?._client?.state === 'configuration';
}

function configurationTransferAgeMs() {
    if (!configTransferStartedAt) return 0;
    return Date.now() - configTransferStartedAt;
}


const STORAGE_AH_SLOTS = 5;
const CLAN_STORAGE_TARGET = 10;

const firstAHSlot = 0;
const lastAHSlot = 17;
const slotToReloadAH = 49;
const slotToStorage = 46;
const leftMouseButton = 0;
const shiftClick = 1;
const slotGlass = 31;

/** mineflayer bot.inventory.slots: 0–4 крафт, 5–8 броня, 9–35 рюкзак, 36–44 хотбар, 45 offhand */
const firstInventorySlot = 9;
const lastInventorySlot = 35;
const firstHotbarSlot = 36;
const lastHotbarSlot = 44;
const offhandSlot = 45;
const warps = ['mine', 'casino', 'case', 'shop', 'portal', 'palach', 'fisher', 'stash'];

function isStorageSlot(slot) {
    return slot >= firstInventorySlot && slot <= lastInventorySlot;
}

function isHotbarSlot(slot) {
    return slot >= firstHotbarSlot && slot <= lastHotbarSlot;
}

/** Шаг мыши vanilla 100% — GCD как в mineflayer bot.look (плавные look-пакеты). */
const LOOK_GCD_STEP = 0.15 * (Math.PI / 180);
/** Доля полного круга (~0.15 ≈ 54°, ~90 шагов, ~4–5 с). */
const LOOK_SPIN_TURNS = 0.15;
/** Средний размер yaw-шага (GCD) для расчёта числа итераций. */
const LOOK_SPIN_AVG_YAW_UNITS = 4;
/** Длительность осмотра (мс): случайно от 3 до 4 с на каждый вызов. */
const LOOK_SPIN_TIMEOUT_MIN_MS = 3000;
const LOOK_SPIN_TIMEOUT_MAX_MS = 4000;

function lookAroundSpinStepCount(turns = LOOK_SPIN_TURNS) {
    const totalTurn = Math.PI * 2 * turns;
    return Math.ceil(totalTurn / (LOOK_SPIN_AVG_YAW_UNITS * LOOK_GCD_STEP));
}

/** Слот инвентаря хотбара (36–44) → quickBar (0–8). 36→0, 37→1, … 44→8 */
function hotbarSlotToQuick(slot) {
    if (!isHotbarSlot(slot)) {
        reportError('hotbarSlotToQuick', `слот ${slot} не хотбар (36–44)`);
        return 0;
    }
    return slot - firstHotbarSlot;
}

/** quickBar (0–8) → слот инвентаря (36–44). 9 → 45 (offhand) — запрещено */
function quickToHotbarSlot(quick) {
    if (quick < 0 || quick > 8) {
        reportError('quickToHotbarSlot', `quick=${quick} вне 0–8`);
        return firstHotbarSlot;
    }
    return firstHotbarSlot + quick;
}

const analysisAH = 'Анализ аукциона';
const myItems = 'Хранилище';
const clan = 'Клан';
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
    catalogAll: workerData.catalogAll ?? workerData.itemPrices ?? [],
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
    trashRtpPending: false,
    needReloadAH: false,
    balance: null,
    needSendAH: true,
    needAdd: false,
    timeActive: Date.now(),
    ip: workerData.ip,
    role: workerData.role,
};

var bot = null;
/** UUID лотов в очереди: { uuid, username } */
let itemsBuying = [];

/**
 * Покупка на АХ: таймер с startedAt переживает авто-обновление окна (без нашего клика).
 * @type {{ slot: number, startedAt: number, totalDelay: number, rechecked: boolean } | null}
 */
let ahBuySession = null;
let rtpInProgress = false;

function claimAhLotUuid(uuid) {
    if (!uuid) return;
    const claim = { uuid, username: config.username };
    itemsBuying = mergeBuyingClaim(itemsBuying, claim);
    parentPort.postMessage({ name: 'buying', data: claim, username: config.username });
}

function ahBuyDelayMs(slot) {
    return delayMs({ min: 500, max: 700 }) * (slot + 2);
}

function clearAhBuySession() {
    ahBuySession = null;
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

/** Окно могло закрыться сервером за время rnd — не передаём null в closeWindow. */
async function safeCloseWindow() {
    if (!bot?.currentWindow) return;
    await rnd('BASE_DELAY');
    const win = bot.currentWindow;
    if (!win) return;
    try {
        await bot.closeWindow(win);
    } catch (err) {
        reportError('safeCloseWindow', err);
    }
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
        return getSlotInfo(item, config.catalogAll, config.goType);
    } catch (err) {
        reportError(`getSlotInfo slot=${slotIndex}`, err);
        return null;
    }
}

/**
 * Слот 0–4 в «Хранилище»: снять мусор, несовпадение цены или лот при переполнении.
 * @returns {{ slot: number, reason: string } | null}
 */
function findStorageSlotToUnlist() {
    let priceOrFullSlot = null;
    let priceOrFullReason = '';

    for (let i = STORAGE_AH_SLOTS - 1; i >= 0; i--) {
        const currentSlot = bot.currentWindow?.slots[i];
        if (!currentSlot) continue;

        const info = getSlotInfoSafe(currentSlot, i);

        if (!info || info.isTrash) {
            return { slot: i, reason: 'мусор (нет в каталоге)' };
        }

        let priceOnAH;
        try {
            priceOnAH = getPriceFromAhItem(currentSlot);
        } catch (err) {
            reportError(`хранилище слот ${i} цена`, err);
            return { slot: i, reason: 'мусор (не читается цена)' };
        }

        if (info.sellPrice !== priceOnAH) {
            if (priceOrFullSlot === null) {
                priceOrFullSlot = i;
                priceOrFullReason = `цена ${priceOnAH} ≠ ${info.sellPrice}`;
            }
            continue;
        }

        if (config.enoughItems && priceOrFullSlot === null) {
            priceOrFullSlot = i;
            priceOrFullReason = 'переполнение хранилища';
        }
    }

    if (priceOrFullSlot !== null) {
        return { slot: priceOrFullSlot, reason: priceOrFullReason };
    }
    return null;
}

/** Слот 1–45 в окне клана: первый предмет из каталога go-типа. */
function findClanWindowConfigSlot() {
    const slots = bot.currentWindow?.slots;
    if (!slots?.length) return null;
    const last = Math.min(45, slots.length - 1);
    for (let i = 1; i <= last; i++) {
        const slotData = slots[i];
        if (!slotData) continue;
        const itemCfg = findMatchingConfigItem(
            slotData,
            config.catalogAll,
            config.goType,
        );
        if (itemCfg?.id) return i;
    }
    return null;
}

/** Слоты 1–45: сколько стаков предметов из каталога в клан-хранилище. */
function countClanStorageConfigItems() {
    const slots = bot.currentWindow?.slots;
    if (!slots?.length) return 0;
    let count = 0;
    const last = Math.min(45, slots.length - 1);
    for (let i = 1; i <= last; i++) {
        const slotData = slots[i];
        if (!slotData) continue;
        const itemCfg = findMatchingConfigItem(
            slotData,
            config.catalogAll,
            config.goType,
        );
        if (itemCfg?.id) count++;
    }
    return count;
}

/** Слот 54–81 в окне клана: первый предмет из каталога (инвентарь бота). */
function findClanDepositSourceSlot() {
    const slots = bot.currentWindow?.slots;
    if (!slots?.length) return null;
    const last = Math.min(81, slots.length - 1);
    for (let i = 54; i <= last; i++) {
        const slotData = slots[i];
        if (!slotData) continue;
        const itemCfg = findMatchingConfigItem(
            slotData,
            config.catalogAll,
            config.goType,
        );
        if (itemCfg?.id) return i;
    }
    return null;
}

const TRY_SELL_MARKER = 'выставлен на продажу за';
const SELL_EMPTY_MARKER = 'Вы не можете продать Воздух';
const SELL_LIST_ACK_TIMEOUT_MS = 300;

/** Ожидание чата после /ah sell — ok | empty | full | timeout */
let sellListAckResolve = null;

function waitSellListAck() {
    return new Promise((resolve) => {
        if (sellListAckResolve) sellListAckResolve('superseded');
        sellListAckResolve = resolve;
        setTimeout(() => {
            if (sellListAckResolve !== resolve) return;
            sellListAckResolve = null;
            resolve('timeout');
        }, SELL_LIST_ACK_TIMEOUT_MS);
    });
}

function finishSellListAck(result) {
    if (!sellListAckResolve) return;
    const resolve = sellListAckResolve;
    sellListAckResolve = null;
    resolve(result);
}

/** Любые разделители (., запятые, $) — в строке остаются только цифры. */
function digitsToInt(text) {
    const digits = String(text).replace(/\D/g, '');
    if (!digits) return NaN;
    return parseInt(digits, 10);
}

function parseChatPrice(text) {
    return digitsToInt(text);
}

/** Цена только из хвоста после «выставлен на продажу за» (для % 100 → тип предмета). */
function parseTrySellPrice(text) {
    const i = text.indexOf(TRY_SELL_MARKER);
    if (i < 0) return NaN;
    return digitsToInt(text.slice(i + TRY_SELL_MARKER.length));
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

async function onBotChatText(text) {
    logChat(text);
    if (text.includes('[⚝] Телепортация!')) {
        config.lastWarpTime = Date.now();
        logInfo('телепортация варпа');
        return;
    }
    await handleChatMessage(text);
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

    if (text.includes(TRY_SELL_MARKER)) {
        const price = parseTrySellPrice(text);
        if (Number.isFinite(price)) {
            const id = getIdBySellPrice(price) || config.goType;
            if (id) parentPort.postMessage({ name: 'try-sell', id, price });
        }
        finishSellListAck('ok');
        return;
    }

    if (text.includes(SELL_EMPTY_MARKER)) {
        finishSellListAck('empty');
        return;
    }

    if (text.includes('[☃] Не удалось выставить') ||
        text.includes('[✘] Ошибка! У Вас переполнено Хранилище!')) {
        config.enoughItems = true;
        finishSellListAck('full');
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
        logWarn('мусор: нельзя выкинуть здесь → needRTP');
        void goRtpTrash('сервер: запрет выкидывания');
        return;
    }

    if (text.includes('[☃] Максимальная цена')) {
        const balance = parseChatPrice(text);
        const info = getHeldItemInfo();
        if (!info?.id || !info.sellPrice) {
            finishSellListAck('skip');
            return;
        }
        const basePrice = Math.floor(balance / 10000) * 10000;
        const marker = info.sellPrice % 100;
        let finalPrice = basePrice + marker;
        if (finalPrice > balance) finalPrice = basePrice - 100 + marker;
        config.needPrice = finalPrice;
        const heldItem = bot.inventory.slots[quickToHotbarSlot(bot.quickBarSlot)];
        const durabilityPercent = getDurabilityPercent(heldItem);
        if (durabilityPercent < 0.9) {
            logInfo(`макс. цена: прочность ${Math.floor(durabilityPercent * 100)}% — в оркестратор не шлём`);
            finishSellListAck('skip');
            return;
        }
        parentPort.postMessage({ name: 'set_max_price', type: info.id, price: finalPrice });
        finishSellListAck('retry');
        return;
    }

    if (text.includes('[☃] Минимальная цена')) {
        const balance = parseChatPrice(text);
        const info = getHeldItemInfo();
        if (!info?.id || !info.sellPrice) {
            finishSellListAck('skip');
            return;
        }

        const basePrice = Math.ceil(balance / 10000) * 10000;
        const marker = info.sellPrice % 100;
        const finalPrice = basePrice + marker + (info.nacenka ?? 0);
        config.needPrice = finalPrice;

        if (text.includes('круш')) {
            finishSellListAck('retry');
            return;
        }

        parentPort.postMessage({ name: 'set_min_price', type: info.id, price: finalPrice });
        finishSellListAck('retry');
        return;
    }

    if (text.includes('BotFilter >> Введите номер с картинки в чат')) {
        parentPort.postMessage(`${workerData.username} - ввести капчу`);
        return;
    }

    if (text.toLowerCase().includes('вы забанены')) {
        parentPort.postMessage(`${workerData.username} - забанен`);
        return;
    }
    if (text.toLowerCase().includes('чтобы двигаться')) {
        parentPort.postMessage(`${workerData.username} - хуйня неведомая`);
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
    if (text.includes('[✘] Ошибка! У Вас не хватает Монет!')) {
        config.needAdd = true;
        if (!config.hasDangerousTrash) await sellItems();
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
    if (data.type === 'price') {
        config.items = data.data;
        if (Array.isArray(data.catalogAll) && data.catalogAll.length) {
            config.catalogAll = data.catalogAll;
        }
    }
    if (data.type === 'items_buying') itemsBuying = data.data ?? [];
});

function parseProxy(str) {
    // socks5://user:pass@ip:port
    const url = new URL(str);

    return {
        host: url.hostname,
        port: Number(url.port),
        username: url.username,
        password: url.password,
    };
}

async function main() {
    const raw = fs.readFileSync('./ip.json', 'utf-8');
    const ipJSON = JSON.parse(raw);
    const proxyString = ipJSON[config.ip];

    const url = new URL(proxyString);
    const proxyHost = url.hostname;
    const proxyPort = Number(url.port);
    const proxyUsername = url.username || undefined;
    const proxyPassword = url.password || undefined;

    const agent = new SocksProxyAgent({
        protocol: 'socks5:',
        host: proxyHost,
        port: proxyPort,
        username: proxyUsername,
        password: proxyPassword,
    });

    bot = mineflayer.createBot({
        username: config.username,
        password: config.password,
        host: 'mc.funtime.su',
        port: 25565,
        version: '1.21.4',
        physicsEnabled: false,
        hideErrors: true,
        logErrors: false,
        agent: agent,
        connect: (client) => {
            SocksClient.createConnection({
                proxy: {
                    host: proxyHost,
                    port: proxyPort,
                    type: 5,
                    userId: proxyUsername,
                    password: proxyPassword,
                },
                command: 'connect',
                destination: {
                    host: 'mc.funtime.su',
                    port: 25565,
                },
            }, (err, info) => {
                if (err) {
                    console.error(`❌ ${config.username} ошибка прокси:`, err.message);
                    process.exit(1);
                }
                client.setSocket(info.socket);
                client.emit('connect');
            });
        },
    });

    setupConfigurationTransferFix(bot);
    setupWindowDebugLog(bot);

    bot.once('inject_allowed', () => {
        setupChatSafeGuard(bot);
    });

    bot.on('spawn', () => {
        bot.physicsEnabled = true;
    });

    // .
    bot.on('scoreboardCreated', (scoreboard) => {
        if (JSON.stringify(scoreboard).includes(`${config.anarchy}`)) {
            markAnarchyJoined();
        }
    });

    bot.on('kicked', (reason) => {
        console.error(`${logTag()} ${ANSI.red}⛔ kicked${ANSI.reset}: ${JSON.stringify(reason)}`);
        process.exit(1);
    });
    bot.on('end', (reason) => {
        console.log(reason)
        process.exit(1);
    });
    bot.on('error', (err) => {
        if (isIgnorableProtocolNoise(err)) return;
        console.error(`${logTag()} ${ANSI.red}⛔ error${ANSI.reset}: ${err}`);
        process.exit(1);
    });

    bot._client?.on('error', (err) => {
        if (isIgnorableProtocolNoise(err)) return;
        console.error(`${logTag()} ${ANSI.red}⛔ client error${ANSI.reset}: ${err}`);
        process.exit(1);
    });

    bot.once('spawn', async () => {
        botWorkerStartTime = Date.now();
        logOk('spawn → /l → sellItems → safeAH');
        await rnd('BASE_DELAY');
        bot.chat(`/l ${config.password}`);
        config.timeJoinAnarchy = 0;
        await sellItems();
    });

    setInterval(async () => {
        if (Date.now() - config.timeActive > 60000) {
            config.timeActive = Date.now();
            await sellItems();
        }
    }, 10_000);

    bot.on('windowOpen', async () => {
        config.timeActive = Date.now();
        // if (bot.currentWindow) {
        //     const { slots, ...winWithoutSlots } = bot.currentWindow;
        //     console.log(JSON.stringify({ ...winWithoutSlots, slotsCount: slots?.length ?? 0 }));
        // }
        const key = generateKey();
        logInfo(`windowOpen → key …${String(key).slice(-6)}`);
        logWindowDebug(bot.currentWindow);
        config.menu = resolveWindowMenu(bot.currentWindow);
        logInfo(`окно: ${config.menu}`);

        if (config.trashRtpPending && config.menu !== rtp) {
            logInfo(`RTP pending → фоновое «${config.menu}», закрываю`);
            await safeCloseWindow();
            return;
        }

        switch (config.menu) {
            case analysisAH:
                if (config.walkTime < Date.now() - 55000 ||
                    (config.needSell && !config.enoughItems && hasBotItem())) {
                    logInfo('АХ → sellItems (осмотр/needSell)');
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

                if (ahBuySession) {
                    logInfo(`АХ → продолжить покупку (слот ${ahBuySession.slot}, сессия)`);
                    await runAhBuySession(key);
                    break;
                }

                const slotToBuy = await getBestAHSlot();
                if (slotToBuy === null || config.needReloadAH) {
                    clearAhBuySession();
                    if (config.needReloadAH) config.needReloadAH = false;
                    logInfo(`АХ → reload 49 (лот=${slotToBuy}, needReload=${config.needReloadAH})`);
                    await safeClickBuy(bot, slotToReloadAH, delayMs({ min: 1500, max: 4500 }), key);
                } else if (slotToBuy < 9) {
                    logInfo(`АХ → купить слот ${slotToBuy}`);
                    ahBuySession = {
                        slot: slotToBuy,
                        startedAt: Date.now(),
                        totalDelay: ahBuyDelayMs(slotToBuy),
                        rechecked: false,
                        running: false,
                    };
                    await runAhBuySession(key);
                } else {
                    clearAhBuySession();
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
                            const itemCfg = findMatchingConfigItem(
                                currentSlot,
                                config.catalogAll,
                                config.goType,
                            );
                            if (itemCfg?.id) botAh.push(itemCfg.id);
                        } else break;
                    }

                    parentPort.postMessage({ name: 'items', username: config.username, items: botAh });
                    config.needSendAH = false;

                    const inv = [];
                    for (let i = 0; i <= lastInventorySlot; i++) {
                        const slotData = bot.inventory.slots[i];
                        if (!slotData) continue;

                        const itemCfg = findMatchingConfigItem(
                            slotData,
                            config.catalogAll,
                            config.goType,
                        );
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

                const unlist = findStorageSlotToUnlist();

                if (unlist !== null) {
                    logInfo(`хранилище → снять слот ${unlist.slot} (${unlist.reason})`);
                    const unlistSlot = unlist.slot;
                    config.needSell = true;
                    config.menu = myItems;
                    await safeClickBuy(bot, unlistSlot, delayMs({ min: 1500, max: 3500 }), key);
                    break;
                }

                if (config.needSell && hasBotItem()) {
                    logInfo('хранилище → sellItems');
                    await sellItems();
                } else {
                    logInfo('хранилище → назад в АХ');
                    config.menu = analysisAH;
                    await safeClickBuy(bot, slotToStorage, delayMs({ min: 1500, max: 4500 }), key);
                }
                break;

            case rtp:
                logOk('RTP → окно, клик слот 0');
                await safeClickBuy(bot, 0, delayMs({ min: 1500, max: 3000 }), key);
                await rnd('RTP');
                config.needRTP = false;
                config.hasDangerousTrash = false;
                config.trashRtpPending = false;
                rtpInProgress = false;
                config.lastWarpTime = Date.now();
                await dropTrashAllAfterRtp();
                logOk('RTP → телепорт OK, sellItems');
                await sellItems();
                break;
              
            case accept:
                logInfo('окно → подтверждение покупки (клик glass)');
                await safeClickBuy(bot, slotGlass, delayMs({ min: 400, max: 1000 }), key);
                break;
        
            case clan:
                logInfo('окно → клан');
                switch (config.role) {
                    case 'seller':
                        if (!config.enoughItems) {
                            const clanSlot = findClanWindowConfigSlot();
                            if (clanSlot !== null) {
                                logInfo(`клан → забрать предмет из слота ${clanSlot} (shift)`);
                                await safeClickBuy(bot, clanSlot, delayMs({ min: 1500, max: 3500 }), key);
                                await safeCloseWindow();
                                await sellItems();
                            } else {
                                logInfo('клан → в хранилище нечего забирать → safeAH');
                                await safeCloseWindow();
                                await safeAH();
                            }
                        }
                        break;
                    case 'buyer': {
                        while (config.menu === clan && bot.currentWindow && config.key === key) {
                            const stored = countClanStorageConfigItems();
                            if (stored >= CLAN_STORAGE_TARGET) {
                                logInfo(`клан → хранилище полное (${stored}/${CLAN_STORAGE_TARGET})`);
                                break;
                            }
                            const depositSlot = findClanDepositSourceSlot();
                            if (depositSlot === null) {
                                logInfo(`клан → нечего класть (${stored}/${CLAN_STORAGE_TARGET})`);
                                config.enoughItems = false;
                                break;
                            }
                            logInfo(`клан → положить предмет из слота ${depositSlot} (${stored}/${CLAN_STORAGE_TARGET})`);
                            await safeClickBuy(bot, depositSlot, delayMs({ min: 1500, max: 3500 }), key);
                            if (config.key !== key) break;
                            await rnd('POLL');
                        }
                        await safeCloseWindow();
                        await safeAH();
                        break;
                    }
                }
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
    if (!config.timeJoinAnarchy) {
        while (!config.timeJoinAnarchy) {
            if (isInConfigurationTransfer()) {
                const ageSec = Math.ceil(configurationTransferAgeMs() / 1000);
                logInfo(`transfer → в configuration ${ageSec}с, жду…`);
                if (configurationTransferAgeMs() > 45_000) {
                    logWarn('transfer → configuration timeout 45с');
                    process.exit(1);
                }
                await rnd('ANARCHY_DELAY');
                continue;
            }
            await rnd('BASE_DELAY');
            logInfo(`/an${config.anarchy}… (жду входа)`);
            bot.physicsEnabled = false;
            bot.chat(`/an${config.anarchy}`);
            await rnd('ANARCHY_DELAY');
        }
    }
    const waitUntil = config.timeJoinAnarchy + 11000;
    if (Date.now() < waitUntil) {
        logInfo(`joinAnarchy → пауза ${Math.ceil((waitUntil - Date.now()) / 1000)}с`);
        while (Date.now() < waitUntil) await rnd('POLL');
    }
}

async function waitWarpTeleport() {
    while (Date.now() - config.lastWarpTime < 7500) await rnd('POLL');
}

/** /rtp — один раз, прерываем sellItems; дальше windowOpen case rtp. */
async function goRtpTrash(reason) {
    if (!bot) {
        logWarn(`RTP → пропуск (${reason}): bot=null`);
        return false;
    }
    if (!config.needRTP && !config.hasDangerousTrash) {
        logInfo(`RTP → пропуск (${reason}): needRTP=false`);
        return false;
    }
    if (config.trashRtpPending || rtpInProgress) {
        logInfo(`RTP → уже ждём окно (${reason})`);
        return true;
    }

    rtpInProgress = true;
    config.trashRtpPending = true;
    config.menu = rtp;
    logWarn(`RTP → старт (${reason})`);
    try {
        await safeCloseWindow();
        await joinAnarchy();
        await waitWarpTeleport();
        await antiAfkIfNeeded();
        if (config.afk) {
            logAfk('RTP → AFK, откладываю /rtp');
            config.trashRtpPending = false;
            rtpInProgress = false;
            return false;
        }
        logOk('RTP → /rtp');
        bot.chat('/rtp');
        return true;
    } catch (err) {
        reportError('goRtpTrash', err);
        config.trashRtpPending = false;
        rtpInProgress = false;
        config.needRTP = true;
        return false;
    }
}

/** Выброс мусора в слоте. true = прервать sellItems (RTP). */
async function tossTrashAtSlot(slot) {
    if (config.trashRtpPending || rtpInProgress) {
        logInfo(`tossTrash slot=${slot} → RTP pending`);
        return true;
    }
    if (config.hasDangerousTrash || config.needRTP) {
        return await goRtpTrash(`tossTrash slot=${slot}`);
    }

    const item = bot.inventory.slots[slot];
    const info = getSlotInfoSafe(item, slot);
    if (!info?.isTrash || !item) return false;

    try {
        logInfo(`tossTrash slot=${slot} → tossStack`);
        await rnd('BASE_DELAY');
        await bot.tossStack(item);
        await rnd('POLL');
    } catch (err) {
        reportError(`tossTrashAtSlot slot=${slot}`, err);
    }
    return false;
}

async function dropTrashAllAfterRtp() {
    for (let i = firstInventorySlot; i <= lastHotbarSlot; i++) {
        const item = bot.inventory.slots[i];
        const info = getSlotInfoSafe(item, i);
        if (!info?.isTrash || !item) continue;
        try {
            logInfo(`RTP → toss slot ${i}`);
            await rnd('BASE_DELAY');
            await bot.tossStack(item);
            await rnd('POLL');
        } catch (err) {
            reportError(`dropTrashAllAfterRtp slot=${i}`, err);
        }
    }
}

async function sellItems() {
    config.timeActive = Date.now();
    logOk('продажа → старт');
    try {
        config.needSell = false;
        config.needSendAH = true;
        await joinAnarchy();

        if (config.needRTP || config.trashRtpPending) {
            logInfo('sellItems → RTP pending, выход');
            return;
        }

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
            await safeCloseWindow();
            if (config.lastWarpTime < Date.now() - 120000) {
                const warp = warps[Math.floor(Math.random() * warps.length)];
                await rnd('BASE_DELAY');
                bot.chat(`/warp ${warp}`);
            }

            if (canSell) {
                await lookAroundSpin();
                if (await dropTrash()) return;
            }

        }

        if (canSell) {
            await moveToHotBar();

            let currentSlot = firstHotbarSlot;
            while (hasBotItem() && !config.enoughItems && currentSlot <= lastHotbarSlot && !config.hasDangerousTrash) {
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
                    const sellPrice = config.needPrice || info.sellPrice;
                    if (config.needPrice) config.needPrice = 0;
                    bot.chat(`/ah sell ${sellPrice}`);
                    let ack = await waitSellListAck();
                    if (ack === 'timeout') {
                        if (config.needPrice) ack = 'retry';
                        else if (config.enoughItems) ack = 'full';
                    }
                    if (ack === 'retry') {
                        logInfo(`sellItems slot=${currentSlot} → min/max цена, повтор`);
                        continue;
                    }
                    if (ack === 'ok') {
                        logOk(`sellItems slot=${currentSlot} → выставлен`);
                    } else if (ack === 'empty' || ack === 'skip') {
                        logInfo(`sellItems slot=${currentSlot} → ${ack === 'empty' ? 'пусто (Воздух)' : 'пропуск'}`);
                    } else if (ack === 'full') {
                        logInfo(`sellItems slot=${currentSlot} → АХ/хранилище забито`);
                    } else {
                        logInfo(`sellItems slot=${currentSlot} → ack ${ack}`);
                    }
                    currentSlot++;
                } catch (err) {
                    reportError(`sellItems ah sell slot=${currentSlot}`, err);
                    finishSellListAck('error');
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
                if (saveSum != null && config.balance != null && config.balance < saveSum/2) {
                    bot.chat(`/clan withdraw ${Math.floor(saveSum/2 - config.balance)}`);
                    config.needAdd = false;
                }
            } else {
                logInfo('sellItems → hasDangerousTrash, safeBalance пропуск');
            }
        } else {
            reportError('sellItems', 'нельзя продавать предметы');
        }

    } catch (err) {
        reportError('sellItems', err);
        await waitWarpTeleport();
    } finally {
        config.needSell = false;
        await waitWarpTeleport();
        logOk('продажа → конец');
    }

    const shouldOpenClanStorage =
        config.role !== 'seller' || !config.enoughItems;
    if (!shouldOpenClanStorage) {
        logInfo('sellItems → clan storage пропуск (seller, enoughItems)');
        await safeAH();
        return;
    }

    if (!bot) return;
    await safeCloseWindow();
    await joinAnarchy();
    await rnd('BASE_DELAY');

    config.botUpdateWindow = true;
    const key = config.key;
    let attempt = 0;
    while (key === config.key) {
        attempt++;
        if (config.afk) logAfk('режим AFK (clan storage)');
        logInfo(`sellItems → /clan storage #${attempt}`);
        await antiAfkIfNeeded();
        if (config.afk) {
            await rnd('AH_CMD');
            continue;
        }
        bot.chat('/clan storage');
        await rnd('AH_CMD');
    }
    logOk(`sellItems → clan storage открыто (${attempt} попыт.)`);
}

async function moveToHotBar() {
    if (config.hasDangerousTrash) {
        logInfo('moveToHotBar → пропуск (hasDangerousTrash)');
        return;
    }
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
                    if (!isStorageSlot(src) || !isHotbarSlot(slot)) {
                        reportError('moveToHotBar', `недопустимый перенос ${src}→${slot}`);
                        break;
                    }
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

/** Осмотр: от текущего yaw/pitch сервера, мелкие GCD-шаги, фикс. число итераций. */
async function lookAroundSpin() {
    if (!bot?.entity) return;

    bot.physicsEnabled = true;
    const startedAt = Date.now();
    const startPitch = bot.entity.pitch;
    const maxPitch = (Math.PI / 2) * 0.22;
    const turnDir = Math.random() < 0.5 ? -1 : 1;
    const steps = lookAroundSpinStepCount();
    const plannedDeg = LOOK_SPIN_TURNS * 360;
    const timeoutMs =
        LOOK_SPIN_TIMEOUT_MIN_MS +
        Math.floor(Math.random() * (LOOK_SPIN_TIMEOUT_MAX_MS - LOOK_SPIN_TIMEOUT_MIN_MS + 1));
    const deadline = startedAt + timeoutMs;
    let doneSteps = 0;

    for (let i = 0; i < steps; i++) {
        if (Date.now() >= deadline) break;

        const yawUnits = 2 + Math.floor(Math.random() * 5);
        const yaw = bot.entity.yaw + turnDir * yawUnits * LOOK_GCD_STEP;

        let pitch = bot.entity.pitch;
        if (Math.random() < 0.15) {
            const pitchUnits = 1 + Math.floor(Math.random() * 2);
            pitch += (Math.random() < 0.5 ? -1 : 1) * pitchUnits * LOOK_GCD_STEP;
            pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
        }

        await bot.look(yaw, pitch, false);
        doneSteps++;
    }

    const elapsedSec = (Date.now() - startedAt) / 1000;
    const timedOut = doneSteps < steps;
    logOk(
        `ОСМОТР ${doneSteps}/${steps} шаг. ~${plannedDeg.toFixed(0)}° за ${elapsedSec.toFixed(1)}с` +
        (timedOut ? ` (таймаут ${(timeoutMs / 1000).toFixed(1)}с)` : '') +
        ` pitch ±${(Math.abs(bot.entity.pitch - startPitch) * 180 / Math.PI).toFixed(1)}°`
    );
    config.walkTime = Date.now();
}

/** Сход с AFK — крутим головой. */
async function antiAfkIfNeeded() {
    if (!config.afk) return;

    logAfk('сходу с AFK → осмотр');

    await safeCloseWindow();

    await lookAroundSpin();
    config.afk = false;
    logOk('AFK снят');
}

/** Пока ключ не сменился (открылось окно АХ) — одно движение и `/ah search`. */
async function safeAH() {
    logOk('safeAH → старт');
    if (!bot) return;
    await safeCloseWindow();
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
        await antiAfkIfNeeded();
        if (config.afk) {
            await rnd('AH_CMD');
            continue;
        }
        await rnd('AH_CMD');
        config.menu = analysisAH;
        bot.chat(`/ah search ${config.item}`);
        await rnd('AH_CMD');
    }
    logOk(`safeAH → выход после ${searchCount} search (открылось окно)`);
}
async function safeBalance() {
    if (!bot) return;
    config.balance = null;
    await safeCloseWindow();
    await joinAnarchy();
    await rnd('BASE_DELAY');

    config.botUpdateWindow = true;

    while (config.balance === null) {
        await antiAfkIfNeeded();
        await rnd('AH_CMD');
        config.menu = analysisAH;
        logInfo('safeBalance → /balance');
        bot.chat(`/balance`);
        await rnd('POLL');
    }
}


/**
 * Покупка с одним startedAt: авто-обновление окна → новый windowOpen продолжает, не ждёт с нуля.
 */
async function runAhBuySession(key) {
    if (!ahBuySession) return;
    if (ahBuySession.running) return;
    ahBuySession.running = true;

    const halfAt = ahBuySession.startedAt + Math.floor(ahBuySession.totalDelay / 2);
    const now = Date.now();
    if (now < halfAt) {
        await sleep(halfAt - now);
    }

    if (config.key !== key) {
        logInfo('АХ покупка: новое окно → сессия сохранена, ждём остаток задержки');
        ahBuySession.running = false;
        return;
    }

    if (!ahBuySession.rechecked) {
        ahBuySession.rechecked = true;
        const slotData = bot?.currentWindow?.slots?.[ahBuySession.slot];
        let currentUUID = null;
        if (slotData) {
            try {
                currentUUID = getItemUUID(slotData);
            } catch (err) {
                reportError(`recheck getItemUUID slot=${ahBuySession.slot}`, err);
            }
        }
        if (currentUUID && isUuidBlockedByOther(itemsBuying, currentUUID, config.username)) {
            logInfo('АХ recheck: UUID занят другим ботом → повторный выбор');
            const newSlot = await getBestAHSlot();
            if (newSlot === null || newSlot >= 9) {
                clearAhBuySession();
                logInfo('АХ → reload 49 (после recheck нет лота)');
                await safeClickBuy(bot, slotToReloadAH, delayMs({ min: 1500, max: 4500 }), key);
                return;
            }
            ahBuySession.slot = newSlot;
            ahBuySession.totalDelay = ahBuyDelayMs(newSlot);
        }
    }

    if (config.key !== key) {
        logInfo('АХ покупка: новое окно после recheck → сессия сохранена');
        ahBuySession.running = false;
        return;
    }

    const startedAt = ahBuySession.startedAt;
    const remaining = Math.max(0, ahBuySession.totalDelay - (Date.now() - startedAt));
    const slot = ahBuySession.slot;
    clearAhBuySession();

    config.botStartClickTime = startedAt;
    config.botUpdateWindow = false;
    await safeClickBuy(bot, slot, remaining, key);
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

            if (currentUUID && isUuidBlockedByOther(itemsBuying, currentUUID, config.username)) {
                continue;
            }

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

            if (currentUUID) claimAhLotUuid(currentUUID);

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
        if (config.trashRtpPending || rtpInProgress) {
            logInfo('dropTrash → RTP pending');
            return true;
        }
        if (config.hasDangerousTrash || config.needRTP) {
            logInfo('dropTrash → hasDangerousTrash, /rtp');
            return await goRtpTrash('dropTrash');
        }

        let slots = 0;
        for (let i = firstInventorySlot; i <= lastHotbarSlot; i++) {
            const item = bot.inventory.slots[i];
            const info = getSlotInfoSafe(item, i);
            if (!info?.isTrash || !item) continue;
            slots++;
            logInfo(`dropTrash → слот ${i}`);
            if (await tossTrashAtSlot(i)) return true;
        }
        if (!slots) logInfo('dropTrash → мусора нет');
        return false;
    } catch (err) {
        reportError('dropTrash', err);
        return false;
    }
}