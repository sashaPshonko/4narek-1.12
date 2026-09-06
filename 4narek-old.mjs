import fs from 'fs'
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import mineflayer from 'mineflayer';
import { workerData, parentPort } from 'worker_threads';
import { rnd, rndPoll, initBotDelayProfile } from './delay/delay.mjs';
import net from 'net';
import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import prismarineChat from 'prismarine-chat';

const ChatMessage = prismarineChat('1.21.11');
// dsdё
import {
    getSlotInfo,
    getItemUUID,
    getPriceFromAhItem,
    AH_FAKE_SLOT_PRICE_MAX,
    findMatchingConfigItem,
    getDurabilityPercent,
    getAllEnchants,
    isBotTradeItem,
    setEnchantRegistry,
    collectAhBookLots,
} from './items/slotInfo.mjs';
import { pricesMatch } from './items/listing-memory.mjs';
import { catalogTypeMatchesGoType } from './lib/go-type.mjs';

import {
    isUuidBlockedByOther,
    mergeBuyingClaim,
} from './items-buying-coord.mjs';
import { handleCaptchaLogin, attachMapCache } from './lib/captcha/solve-flow.mjs';
import {
    ahBuyDelayMs,
    ahGlassDelayMs,
    ahFakeSlotBuyDelayMs,
    pickAhBrowseAction,
    initAhTempo,
} from './lib/ah-buy-tempo.mjs';
import { pickWarp, shouldAttemptWarp } from './lib/warp-pick.mjs';
import { runAntiAfkMotion, nextWalkGapMs } from './lib/afk-look.mjs';
import { patchWalking121 } from './lib/walk-121.mjs';
import { VANILLA_BOT_OPTS, applyVanillaClientSettings, ensurePhysicsOn } from './lib/vanilla-client.mjs';
import { waitForEventLoopOk } from './lib/event-loop-guard.mjs';
import { extractBanReason } from './lib/clan-owner-ping.mjs';

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
    if (msg.includes('array size is abnormally large')) return true;
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

/** Достаёт run_command из click_event / clickEvent (1.21+ и старый формат). */
function collectClickCommands(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    const click = node.click_event || node.clickEvent || node.json?.click_event || node.json?.clickEvent;
    if (click && typeof click === 'object') {
        const action = click.action;
        const cmd = click.command || click.value;
        if (
            (action === 'run_command' || action === 'suggest_command') &&
            typeof cmd === 'string' &&
            cmd.trim()
        ) {
            out.push(cmd.trim());
        }
    }
    for (const child of node.extra || []) collectClickCommands(child, out);
    if (node.json) collectClickCommands(node.json, out);
    for (const child of node.json?.extra || []) collectClickCommands(child, out);
    if (Array.isArray(node.with)) {
        for (const child of node.with) collectClickCommands(child, out);
    }
    return out;
}

function findClanAcceptInRaw(raw) {
    if (raw == null || raw === '') return null;
    let node = raw;
    if (typeof raw === 'string') {
        try {
            node = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    try {
        const msg = ChatMessage.fromNotch(raw);
        const hit = collectClickCommands(msg).find((c) => /^\/clan\s+accept\b/i.test(c));
        if (hit) return hit;
    } catch {
        /* raw JSON ниже */
    }
    return collectClickCommands(node).find((c) => /^\/clan\s+accept\b/i.test(c)) || null;
}

/** После /clan leave FunTime шлёт клик `/clan leave true`. */
function findClanLeaveConfirmInRaw(raw) {
    if (raw == null || raw === '') return null;
    let node = raw;
    if (typeof raw === 'string') {
        try {
            node = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    const isLeaveTrue = (c) => /^\/clan\s+leave\s+true\b/i.test(c);
    try {
        const msg = ChatMessage.fromNotch(raw);
        const hit = collectClickCommands(msg).find(isLeaveTrue);
        if (hit) return hit;
    } catch {
        /* raw JSON ниже */
    }
    return collectClickCommands(node).find(isLeaveTrue) || null;
}

const OLD_ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_PERSONAL_BALANCE = 2_500_000_000;
const CLAN_MEMBERS_MARKER = 'Участники:';
const CLAN_BALANCE_CHAT_MARKER = 'Баланс клана:';
const CLAN_WITHDRAW_MID = ' снял $';
const CLAN_WITHDRAW_TAIL = ' из казны';

let pendingClanLeaveConfirm = null;
let clanLeaderNick = null;
let clanMembersList = null;
let clanTreasuryBal = null;
let selfWithdrawSeen = false;
let notInClanHint = false;
let foreignClanLeaveBusy = false;

function nickInChat(text, nick) {
    const esc = String(nick || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!esc) return false;
    return new RegExp(`\\b${esc}\\b`, 'i').test(String(text || ''));
}

function parseClanLeaderFromChat(text) {
    if (!text?.includes(CLAN_MEMBERS_MARKER)) return null;
    const m = String(text).match(/\[Лидер\]\s*([a-zA-Z0-9_]{3,16})/i);
    return m ? m[1] : null;
}

function parseClanMembersFromChat(text) {
    if (!text?.includes(CLAN_MEMBERS_MARKER)) return null;
    const idx = text.indexOf(CLAN_MEMBERS_MARKER);
    const tail = text.slice(idx + CLAN_MEMBERS_MARKER.length);
    const names = [];
    const re = /\][\s]*([a-zA-Z0-9_]{3,16})/g;
    let m;
    while ((m = re.exec(tail)) !== null) names.push(m[1]);
    return names.length ? names : null;
}

function parseClanTreasuryFromChat(text) {
    if (!text?.includes(CLAN_BALANCE_CHAT_MARKER)) return null;
    const m = String(text).match(/Баланс клана:\s*([\d.\s\u00a0,$]+)/i);
    const n = m ? digitsToInt(m[1]) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : null;
}

function expectedClanOwnerNick() {
    try {
        const raw = fs.readFileSync(join(OLD_ROOT, 'clan-owners.json'), 'utf8');
        const owners = JSON.parse(raw);
        const row = owners[String(config.anarchy)];
        return String(row?.username || '').trim();
    } catch {
        return '';
    }
}

function sleepMs(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Не совмещать осмотр мыши с chat/кликами.
 * bot.chat ставится в очередь и ждёт конца look; look ждёт flush chat + паузу после команды.
 */
let lookLock = false;
let lastChatAt = 0;
let lastLookAt = 0;
let chatChain = Promise.resolve();

function installPlayerActionGate(bot) {
    if (!bot || bot._actionGateInstalled) return;
    bot._actionGateInstalled = true;
    // bot.chat появляется только когда mineflayer инжектит плагины (inject_allowed)
    if (typeof bot.chat === 'function') wrapChat(bot);
    else bot.once('inject_allowed', () => wrapChat(bot));
}

function wrapChat(bot) {
    if (typeof bot.chat !== 'function') return;
    const origChat = bot.chat.bind(bot);
    bot.chat = (message) => {
        chatChain = chatChain
            .then(async () => {
                while (lookLock) {
                    await sleepMs(40);
                }
                const sinceLook = lastLookAt ? Date.now() - lastLookAt : 9999;
                if (sinceLook < 280) {
                    await sleepMs(280 - sinceLook);
                }
                origChat(message);
                lastChatAt = Date.now();
            })
            .catch((err) => reportError('gatedChat', err));
    };
}

/** Дождаться очереди chat и отсутствия осмотра. */
async function waitActionsSettled(shouldAbort = null) {
    await chatChain;
    const start = Date.now();
    while (lookLock) {
        if (typeof shouldAbort === 'function' && shouldAbort()) return false;
        if (Date.now() - start > 20000) {
            logWarn('lookLock timeout → снимаю');
            lookLock = false;
            break;
        }
        await sleepMs(40);
    }
    return !(typeof shouldAbort === 'function' && shouldAbort());
}

/** Пауза после последней команды, чтобы look не наложился на /warp,/ah и т.п. */
async function pauseAfterChatBeforeLook(shouldAbort = null) {
    await chatChain;
    if (typeof shouldAbort === 'function' && shouldAbort()) return false;
    if (!lastChatAt) return true;
    const need = 550 + Math.floor(Math.random() * 750); // 0.55–1.3 с
    const left = need - (Date.now() - lastChatAt);
    if (left > 0) await sleepMs(left);
    return !(typeof shouldAbort === 'function' && shouldAbort());
}

function setupChatSafeGuard(bot) {
    const client = bot._client;
    if (!client) return;

    client.removeAllListeners('playerChat');
    client.removeAllListeners('systemChat');

    const onPacket = (data) => {
        const raw = data?.formattedMessage ?? data?.content ?? data?.unsignedContent;
        const text = chatTextFromRaw(data);
        if (text) void onBotChatText(text);
        const leaveConfirm = findClanLeaveConfirmInRaw(raw);
        if (leaveConfirm) pendingClanLeaveConfirm = leaveConfirm;
        const accept = findClanAcceptInRaw(raw);
        if (accept) void handleClanInviteAccept(accept);
    };

    client.on('playerChat', onPacket);
    client.on('systemChat', onPacket);
}

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

    if (windowJSON.includes('хранилище')) return myItems;
    if (windowJSON.includes('телепорт') || windowJSON.includes('телепортации')) return rtp;
    if (windowJSON.includes('подозрительная цена') ||
        windowJSON.includes('подтверждение покупки')) {
        return accept;
    }
    return analysisAH;
}

function ensureRegistryDimensionStub(bot) {
    if (Array.isArray(bot.registry.dimensionsArray) && bot.registry.dimensionsArray.length > 0) {
        return;
    }
    const fallback = { name: 'minecraft:overworld', minY: -64, height: 384 };
    bot.registry.dimensionsArray = Array.from({ length: 16 }, () => fallback);
    bot.registry.dimensionsByName ??= { overworld: fallback };
}

const CONFIG_BLOCKED_PACKETS = new Set([
    'position', 'look', 'position_look', 'flying',
    'chat', 'chat_command', 'chat_command_signed', 'chat_message',
    'window_click', 'close_window',
    'arm_animation', 'entity_action',
    'held_item_slot', 'set_creative_slot',
    'player_input', 'tick_end',
]);

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
        applyVanillaClientSettings(bot);
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

const firstAHSlot = 0;
/** Две строки лотов АХ: 0–8 и 9–17. */
const lastAHSlot = 17;
const lastBuyableAHSlot = 17;
const slotToStorage = 46;
const leftMouseButton = 0;
const shiftClick = 1;
const noShiftClick = 0;
const slotGlass = 0;

/** mineflayer bot.inventory.slots: 0–4 крафт, 5–8 броня, 9–35 рюкзак, 36–44 хотбар, 45 offhand */
const firstInventorySlot = 9;
const lastInventorySlot = 35;
const firstHotbarSlot = 36;
const lastHotbarSlot = 44;

/** Рюкзак (27) + 5 ячеек хотбара = 32 слота для учёта «своих» предметов. */
const botInventoryTrackFirstSlot = firstInventorySlot;
const botInventoryTrackLastSlot = 40;
/** Порог «инвентарь забит» — 27 из 32 слотов заняты предметами go-типа бота. */
const botInventoryFullThreshold = 27;
const offhandSlot = 45;

function isStorageSlot(slot) {
    return slot >= firstInventorySlot && slot <= lastInventorySlot;
}

function isHotbarSlot(slot) {
    return slot >= firstHotbarSlot && slot <= lastHotbarSlot;
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

/** Solver капчи (хардкод, без env). Если боты не на той же машине — поменяй IP. */
const CAPTCHA_SOLVER_URL = 'http://127.0.0.1:8799';

let captchaBusy = false;
let clanAcceptBusy = false;

async function handleClanInviteAccept(acceptCmd) {
    if (!acceptCmd || clanAcceptBusy || !bot) return;
    clanAcceptBusy = true;
    try {
        // не принимать клан поверх осмотра / в середине клика
        await waitActionsSettled();
        // сбрасываем текущий windowOpen-цикл (АХ и т.п.)
        config.key = generateKey();
        logOk(`клан → закрываю окно, ${acceptCmd}`);
        await closeCurrentWindowSafe();
        await rnd('BASE_DELAY');
        bot.chat(acceptCmd);
        await chatChain;
        await rnd('BASE_DELAY');
        await sellItems();
        await safeAH();
    } catch (err) {
        reportError('clan accept', err);
    } finally {
        clanAcceptBusy = false;
    }
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
    lastWarp: null,
    enoughItems: false,
    items: workerData.itemPrices ?? [],
    catalogAll: workerData.catalogAll ?? workerData.itemPrices ?? [],
    needSell: false,
    sellInFlight: false,
    /** Поколение sellItems — лобби/таймаут бампят, старая сессия выходит. */
    sellGen: 0,
    sellStartedAt: 0,
    needReset: false,
    walkTime: 0,
    walkGapMs: 55_000,
    BuyingItem: { id: '', price: 0, buyPrice: 0, nacenka: 0, enchants: [], durability: null },
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
    needAdd: false,
    timeActive: Date.now(),
    lastClanInvestAt: 0,
    ownerBanDrain: false,
    ownerBanLeaveDone: false,
    ip: workerData.ip,
};

initBotDelayProfile(config.username);
initAhTempo(config.username);

var bot = null;
/** UUID лотов в очереди: { uuid, username } */
let itemsBuying = [];

const listingWait = new Map();
let listingReqSeq = 0;

const warpPickWait = new Map();
let warpPickReqSeq = 0;

/** Оркестратор разводит ботов по варпам; при таймауте — локальный pick. */
function warpPickOp(payload = {}, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const reqId = ++warpPickReqSeq;
        const timer = setTimeout(() => {
            warpPickWait.delete(reqId);
            reject(new Error('warp_pick timeout'));
        }, timeoutMs);
        warpPickWait.set(reqId, (warp) => {
            clearTimeout(timer);
            resolve(warp);
        });
        parentPort.postMessage({
            name: 'warp_pick',
            reqId,
            anarchy: config.anarchy,
            ...payload,
        });
    });
}

async function pickWarpForSession() {
    try {
        return await warpPickOp({ lastWarp: config.lastWarp ?? null });
    } catch {
        return pickWarp({
            username: config.username,
            anarchy: config.anarchy,
            lastWarp: config.lastWarp ?? null,
        });
    }
}

/** RPC в оркестратор: listing memory (alloc / confirm / takeSold / sync). */
function listingOp(op, payload = {}, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
        const reqId = ++listingReqSeq;
        const timer = setTimeout(() => {
            listingWait.delete(reqId);
            reject(new Error(`listing ${op} timeout`));
        }, timeoutMs);
        listingWait.set(reqId, (result) => {
            clearTimeout(timer);
            resolve(result);
        });
        parentPort.postMessage({ name: 'listing', reqId, op, ...payload });
    });
}

function snapshotItemTradeMeta(item) {
    if (!item) return { enchants: [], durability: null };
    let enchants = [];
    try {
        enchants = getAllEnchants(item) || [];
    } catch {
        enchants = [];
    }
    let durability = null;
    try {
        const d = getDurabilityPercent(item);
        if (Number.isFinite(d)) durability = Math.round(d * 1000) / 1000;
    } catch {
        durability = null;
    }
    return { enchants, durability };
}

async function syncListingIdsFromStorageWindow() {
    const prices = [];
    for (let i = 0; i < STORAGE_AH_SLOTS; i++) {
        const slot = bot?.currentWindow?.slots?.[i];
        if (!slot) continue;
        try {
            const p = getPriceFromAhItem(slot);
            if (Number.isFinite(p) && p > 0) prices.push(p);
        } catch {
            /* слот без цены */
        }
    }
    try {
        await listingOp('sync', { prices });
    } catch (e) {
        logWarn(`listing sync: ${e.message}`);
    }
}

function claimAhLotUuid(uuid) {
    if (!uuid) return;
    const claim = { uuid, username: config.username };
    itemsBuying = mergeBuyingClaim(itemsBuying, claim);
    parentPort.postMessage({ name: 'buying', data: claim, username: config.username });
}

const FUNAUTH_VERIFY_MS = 5000;
let funauthVerifyTimer = null;
let funauthBindRequired = false;
let funauthGameVerified = false;

function cancelFunauthVerifyTimer() {
    if (funauthVerifyTimer) {
        clearTimeout(funauthVerifyTimer);
        funauthVerifyTimer = null;
    }
}

function scheduleFunauthVerify() {
    cancelFunauthVerifyTimer();
    if (funauthGameVerified || funauthBindRequired) return;
    funauthVerifyTimer = setTimeout(() => {
        funauthVerifyTimer = null;
        if (funauthBindRequired || funauthGameVerified) return;
        funauthGameVerified = true;
        logOk('FunAuth уже привязан — 5с на анке без «чтобы двигаться»');
        parentPort.postMessage({
            name: 'funauth_verified',
            username: config.username,
            anarchy: config.anarchy,
        });
    }, FUNAUTH_VERIFY_MS);
}

function markAnarchyJoined() {
    config.timeJoinAnarchy = Date.now();
    funauthBindRequired = false;
    ensurePhysicsOn(bot);
    scheduleFunauthVerify();
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

/** Ошибки парсинга слота АХ — в TG шлём #slot + JSON, не stack. Подозрительные цены не шлём. */
function reportSlotError(where, err, slotData) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/подозрительная цена/i.test(msg)) {
        console.warn(`${logTag()} ${ANSI.yellow}!${ANSI.reset} ${where}: ${msg} (в TG не шлём)`);
        return;
    }
    let json = '?';
    try {
        json = JSON.stringify(slotData);
        if (json.length > 3500) json = `${json.slice(0, 3500)}…[trunc ${json.length}]`;
    } catch (serErr) {
        json = `[serialize fail: ${serErr.message}]`;
    }
    const text = `#slot ${config.username} — ${where}: ${msg}\n${json}`;
    console.error(`${logTag()} ${ANSI.red}✖${ANSI.reset} ${ANSI.red}${where}${ANSI.reset}: ${msg}`);
    parentPort.postMessage(text);
}

/**
 * Окно АХ зависло: после клика ни windowOpen, ни смена слотов.
 * В TG — JSON окна без slots. `menu` / `pass` / `contentSame` — наши поля, не FunTime.
 */
function reportStaleAhWindow(win, meta = {}) {
    let json = '?';
    try {
        const { slots: _slots, ...windowWithoutSlots } = win ?? {};
        json = JSON.stringify({
            ...windowWithoutSlots,
            menu: config.menu,
            ...meta,
        });
        if (json.length > 3500) json = `${json.slice(0, 3500)}…[trunc ${json.length}]`;
    } catch (serErr) {
        json = `[serialize fail: ${serErr.message}]`;
    }
    const text = `#ah-stale ${config.username} — АХ завис (слоты не изменились)\n${json}`;
    console.warn(`${logTag()} ${ANSI.yellow}!${ANSI.reset} ah-stale: слоты не изменились`);
    parentPort.postMessage(text);
}

/** Отпечаток лотов АХ (0..inventoryStart−1) — ловим in-place update без windowOpen. */
function ahWindowContentKey(win) {
    if (!win?.slots) return '';
    const end = Number.isFinite(win.inventoryStart) ? win.inventoryStart : 54;
    const parts = [];
    for (let i = 0; i < end; i++) {
        const item = win.slots[i];
        if (!item) {
            parts.push(`${i}:`);
            continue;
        }
        let uuid = '';
        try {
            uuid = getItemUUID(item) || '';
        } catch {
            /* ignore */
        }
        parts.push(
            `${i}:${item.name || '?'}:${item.count ?? 0}:${uuid}:${item.nbt ? 'n' : ''}`,
        );
    }
    return parts.join('|');
}

/** Новый ключ: этот windowOpen. Клик не бросаем — дожимаем остаток задержки уже с новым ключом. */
function generateKey() {
    config.key = Math.random().toString(36).substring(2, 15);
    return config.key;
}

/** Слот + сколько ждали: глина/новый windowOpen не сбрасывает таймер. */
let pendingClick = null;

function remainingPendingMs() {
    if (!pendingClick) return 0;
    return Math.max(0, pendingClick.totalDelay - (Date.now() - pendingClick.startedAt));
}

function armPendingClick(slot, time, shift) {
    const sh = Boolean(shift);
    if (
        pendingClick &&
        pendingClick.slot === slot &&
        pendingClick.shift === sh
    ) {
        return remainingPendingMs();
    }
    pendingClick = {
        slot,
        startedAt: Date.now(),
        totalDelay: time,
        shift: sh,
    };
    return time;
}

function delayMs(range) {
    if (typeof range === 'number') return range;
    return Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Почему currentWindow стал null. Mineflayer обнуляет его только так. */
let lastWindowGone = { at: 0, why: '', windowId: null };

function noteWindowGone(why, windowId = null) {
    lastWindowGone = { at: Date.now(), why, windowId };
    logWarn(`GUI закрылось: ${why}${windowId != null ? ` id=${windowId}` : ''}`);
}

function attachWindowCloseTrace(bot) {
    const client = bot._client;
    if (client) {
        client.prependListener('close_window', (packet) => {
            noteWindowGone('сервер close_window', packet?.windowId);
        });
        client.prependListener('login', () => {
            if (bot.currentWindow) {
                noteWindowGone('пакет login (mineflayer сносит окно при смене мира)', bot.currentWindow.id);
            }
        });
    }
    const wrapClose = () => {
        if (typeof bot.closeWindow !== 'function') return;
        const origClose = bot.closeWindow.bind(bot);
        bot.closeWindow = (win) => {
            noteWindowGone('мы closeWindow', win?.id);
            return origClose(win);
        };
    };
    if (typeof bot.closeWindow === 'function') wrapClose();
    else bot.once('inject_allowed', wrapClose);
}

/** FunTime часто: close_window → (дыра 0–2с) → open_window. Vanilla за это не «теряет» АХ. */
async function waitForCurrentWindow(maxMs, key = null) {
    const deadline = Date.now() + maxMs;
    while (!bot?.currentWindow && Date.now() < deadline) {
        if (key != null && config.key !== key) return 'newkey';
        await sleep(50);
    }
    return bot?.currentWindow ? 'ok' : 'gone';
}

/** @param {boolean} [shift] — true только при клике по лоту покупки */
async function safeClickBuy(bot, slot, time, key, shift = false) {
    if (!(await waitActionsSettled(() => config.key !== key))) return;
    await waitForEventLoopOk({ log: (m) => logWarn(m) });
    const timeDelay = armPendingClick(slot, time, shift);
    config.botUpdateWindow = false;
    config.botStartClickTime = pendingClick.startedAt;

    let remaining = timeDelay;
    while (remaining > 0) {
        if (config.key !== key) {
            logInfo(`клик слот ${slot} → новое окно, остаток ${remaining}мс`);
            return;
        }
        if (!bot.currentWindow) {
            const waited = await waitForCurrentWindow(2000, key);
            if (waited === 'newkey') {
                logInfo(`клик слот ${slot} → новое окно (reopen), остаток ${remainingPendingMs()}мс`);
                return;
            }
            if (!bot.currentWindow) {
                logWarn(
                    `клик слот ${slot} — GUI так и нет (${lastWindowGone.why || '?'}, ${Date.now() - lastWindowGone.at}мс назад)`,
                );
                pendingClick = null;
                return;
            }
            logInfo(`клик слот ${slot} — окно вернулось после ${lastWindowGone.why || 'close'}`);
        }
        const chunk = Math.min(100, remaining);
        await sleep(chunk);
        remaining -= chunk;
    }

    if (config.key !== key) {
        logInfo(`клик слот ${slot} → новое окно, остаток ${remainingPendingMs()}мс`);
        return;
    }

    pendingClick = null;
    config.botUpdateWindow = true;
    if (!bot.currentWindow) {
        const waited = await waitForCurrentWindow(2000, key);
        if (waited !== 'ok') {
            logWarn(
                `клик слот ${slot} — не кликнул, GUI нет (${lastWindowGone.why || '?'})`,
            );
            return;
        }
    }
    const mode = shift ? shiftClick : noShiftClick;
    logInfo(`клик слот ${slot}${shift ? ' (shift)' : ''}`);
    if (!(await waitActionsSettled(() => config.key !== key))) return;
    await bot.clickWindow(slot, leftMouseButton, mode);
}

function getSlotInfoSafe(item, slotIndex) {
    try {
        return getSlotInfo(item, config.catalogAll, config.goType);
    } catch (err) {
        reportError(`getSlotInfo slot=${slotIndex}`, err);
        return null;
    }
}

const ahBookSentUuids = new Set();

function flushAhBookLots(extraItem) {
    const raw = collectAhBookLots(
        bot?.currentWindow?.slots,
        firstAHSlot,
        lastAHSlot,
        config.catalogAll,
        { skipSeller: config.username, extraItem },
    );
    const lots = [];
    for (const lot of raw) {
        if (ahBookSentUuids.has(lot.uuid)) continue;
        ahBookSentUuids.add(lot.uuid);
        lots.push({
            ...lot,
            anarchy: workerData.anarchy,
            seen_by: config.username,
        });
    }
    if (ahBookSentUuids.size > 40000) ahBookSentUuids.clear();
    if (!lots.length) return;
    parentPort.postMessage({ name: 'ah_lots', lots });
}

/**
 * Слот 0–4 в «Хранилище»: снять мусор / несовпадение цены.
 * Если инвентарь ≥27 своих — снимаем любой свой лот (цикл: снять всё → продать всё).
 * @returns {{ slot: number, reason: string } | null}
 */
function findStorageSlotToUnlist() {
    let priceOrFullSlot = null;
    let priceOrFullReason = '';
    const invFull = isBotInventoryFull();

    for (let i = STORAGE_AH_SLOTS - 1; i >= 0; i--) {
        const currentSlot = bot.currentWindow?.slots[i];
        if (!currentSlot) continue;

        const info = getSlotInfoSafe(currentSlot, i);

        // Чужая категория — оставляем на АХ, не снимаем и не считаем мусором
        if (info?.isForeignCategory) continue;

        if (!info || info.isTrash) {
            return { slot: i, reason: 'мусор (нет в каталоге)' };
        }

        let priceOnAH;
        try {
            priceOnAH = getPriceFromAhItem(currentSlot);
        } catch (err) {
            reportSlotError(`хранилище слот ${i} цена`, err, currentSlot);
            return { slot: i, reason: 'мусор (не читается цена)' };
        }

        if (!pricesMatch(priceOnAH, info.sellPrice)) {
            if (priceOrFullSlot === null) {
                priceOrFullSlot = i;
                priceOrFullReason = `цена ${priceOnAH} ≠ ${info.sellPrice}`;
            }
            continue;
        }

        if (invFull && priceOrFullSlot === null) {
            priceOrFullSlot = i;
            priceOrFullReason = 'инвентарь ≥27 — снять для перевыставления';
        }
    }

    if (priceOrFullSlot !== null) {
        return { slot: priceOrFullSlot, reason: priceOrFullReason };
    }
    return null;
}

const TRY_SELL_MARKER = 'выставлен на продажу за';
const SELL_EMPTY_MARKER = 'Вы не можете продать Воздух';
/** Ждём ответ чата дольше — «слишком дорого» приходит не за 300мс. */
const SELL_LIST_ACK_TIMEOUT_MS = 2500;
const SELL_SLOT_MAX_ATTEMPTS = 5;
/** FunTime: /clan invest не чаще раза в 15 минут */
const CLAN_INVEST_COOLDOWN_MS = 15 * 60 * 1000;
/** Макс. длительность одной продажи — иначе залипает sellInFlight и лобби не может перезайти. */
const SELL_ITEMS_MAX_MS = 3 * 60 * 1000;

let sellListAckResolve = null;

function sellSlotIsEmpty(slotIndex) {
    const item = bot?.inventory?.slots?.[slotIndex];
    if (!item) return true;
    const info = getSlotInfoSafe(item, slotIndex);
    return !info || !!info.isTrash;
}

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

/** Цифры из фрагмента (точки/пробелы — разделители тысяч). */
function digitsToInt(text) {
    const digits = String(text).replace(/\D/g, '');
    if (!digits) return NaN;
    return parseInt(digits, 10);
}

/**
 * Цена из чата. Не склеивать все цифры строки («x64 … за 80.000» ≠ 6480000).
 */
function parseChatPrice(text) {
    const s = String(text || '');
    const afterZa = s.match(/за\s*([\d.\s\u00a0]+)/i);
    if (afterZa) {
        const n = digitsToInt(afterZa[1]);
        if (Number.isFinite(n) && n > 0) return n;
    }
    const groups = [...s.matchAll(/(\d(?:[\d.\s\u00a0]*\d)?)/g)]
        .map((m) => digitsToInt(m[1]))
        .filter((n) => Number.isFinite(n) && n >= 1000);
    if (groups.length) return groups[groups.length - 1];
    const n = digitsToInt(s);
    return Number.isFinite(n) && n > 0 ? n : NaN;
}

/** Цена только из хвоста после «выставлен на продажу за» (listing id = последняя цифра). */
function parseTrySellPrice(text) {
    const i = text.indexOf(TRY_SELL_MARKER);
    if (i < 0) return NaN;
    return digitsToInt(text.slice(i + TRY_SELL_MARKER.length));
}

/** true — у предмета категории бота (goType) изменилась priceSell с прошлого апдейта Go. */
function hasBotCategoryPriceChanged(prevItems, nextItems) {
    if (!Array.isArray(nextItems) || !nextItems.length) return false;

    const prevById = new Map();
    if (Array.isArray(prevItems)) {
        for (const item of prevItems) {
            if (item?.id == null || typeof item.priceSell !== 'number') continue;
            prevById.set(item.id, item.priceSell);
        }
    }
    if (!prevById.size) return false;

    for (const item of nextItems) {
        if (item?.id == null || typeof item.priceSell !== 'number') continue;
        const oldPrice = prevById.get(item.id);
        if (oldPrice !== undefined && oldPrice !== item.priceSell) return true;
    }
    return false;
}

/** Сумма 5× самого дорогого предмета из каталога бота (priceSell, goType). */
function getSaveSum() {
    if (!Array.isArray(config.items) || !config.items.length) return null;

    let bestPrice = 0;
    for (const entry of config.items) {
        if (!entry?.id?.endsWith('1.21')) continue;
        if (config.goType && !catalogTypeMatchesGoType(entry.type, config.goType, entry.name)) continue;

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

/** FunTime: /clan * без членства */
const CLAN_HELP_MARKER = '[⚔] Помощь по Кланам';
/** FunTime: в клане, но нет прав на команду (withdraw/invest и т.п.) */
const CLAN_NO_PERMS_MARKER = '[⚔] У тебя нет полномочий для этой команды!';
/** FunTime: /clan withdraw при пустой казне */
const CLAN_TREASURY_LOW = '[⚔] Ошибка: Баланс казны меньше веденной суммы!';
let treasuryEmptyReported = false;

/** Баланс «в норме» для Go: ≥ половины saveSum (не нужен withdraw). */
function maybeRestoreGoPresenceFromBalance() {
    if (!treasuryEmptyReported) return;
    const saveSum = getSaveSum();
    if (saveSum == null || config.balance == null || !Number.isFinite(config.balance)) return;
    if (config.balance < saveSum / 2) return;
    treasuryEmptyReported = false;
    logOk(`баланс в норме (${config.balance}) → presence active для Go`);
    parentPort.postMessage({ name: 'treasury_ok' });
}

async function handleChatMessage(text) {
    const treasury = parseClanTreasuryFromChat(text);
    if (treasury != null) clanTreasuryBal = treasury;
    const leader = parseClanLeaderFromChat(text);
    if (leader) clanLeaderNick = leader;
    const members = parseClanMembersFromChat(text);
    if (members) clanMembersList = members;
    if (
        text.includes('Игрок')
        && text.includes(CLAN_WITHDRAW_MID)
        && text.includes(CLAN_WITHDRAW_TAIL)
        && nickInChat(text, config.username)
    ) {
        selfWithdrawSeen = true;
        logOk(`снятие из казны: ${text.slice(0, 120)}`);
    }

    if (text.includes(CLAN_HELP_MARKER) || text.includes(CLAN_NO_PERMS_MARKER)) {
        if (text.includes(CLAN_HELP_MARKER)) notInClanHint = true;
        if (foreignClanLeaveBusy || config.ownerBanDrain) {
            logWarn(`clan → ${text.includes(CLAN_HELP_MARKER) ? 'not_in_clan' : 'no_perms'} (leave/owner ban)`);
            return;
        }
        const reason = text.includes(CLAN_HELP_MARKER) ? 'not_in_clan' : 'no_perms';
        logWarn(`clan → ${reason} → clan-setup an${config.anarchy}`);
        parentPort.postMessage({
            name: 'clan_setup',
            anarchy: config.anarchy,
            reason,
        });
        return;
    }
    if (text.includes('[✔] Предметы успешно перевыставлены!')) {
        config.lastResetTime = Date.now();
        config.needReset = false;
        return;
    }
    if (text.includes('[☃] Вы успешно купили')) {
        const fromChat = parseChatPrice(text);
        const known = Number(config.BuyingItem.price);
        const price = known > 0 && Number.isFinite(known) ? known : fromChat;
        const id = config.BuyingItem.id;
        if (!id) {
            logWarn(`buy confirm без BuyingItem (price=${price}) — дубль чата, skip`);
            return;
        }
        parentPort.postMessage({
            name: 'buy',
            id,
            price,
            enchants: config.BuyingItem.enchants || [],
            durability: config.BuyingItem.durability,
        });
        config.BuyingItem = { id: '', price: 0, buyPrice: 0, nacenka: 0, enchants: [], durability: null };
        config.needSell = true;
        return;
    }

    if (text.includes('[☃] У Вас купили')) {
        config.enoughItems = false;
        const price = parseChatPrice(text);
        let meta = null;
        try {
            meta = await listingOp('takeSold', { price });
        } catch (e) {
            logWarn(`sell listing: ${e.message}`);
        }
        if (!meta?.catalogId) {
            logWarn(`sell: нет памяти listing id=${Number.isFinite(price) ? price % 10 : '?'} price=${price}`);
            config.needSell = true;
            return;
        }
        parentPort.postMessage({
            name: 'sell',
            id: meta.catalogId,
            price,
            enchants: meta.enchants || [],
            durability: meta.durability ?? null,
        });
        config.needSell = true;
        return;
    }

    if (text.includes(TRY_SELL_MARKER)) {
        const price = parseTrySellPrice(text);
        if (!Number.isFinite(price)) return;
        let confirmed = null;
        try {
            confirmed = await listingOp('confirm', { price });
        } catch (e) {
            logWarn(`try-sell listing: ${e.message}`);
        }
        if (!confirmed?.catalogId) {
            logWarn(`try-sell: не подтвердился listing id=${price % 10} price=${price}`);
            finishSellListAck('ok');
            return;
        }
        parentPort.postMessage({ name: 'try-sell', id: confirmed.catalogId, price });
        finishSellListAck('ok');
        return;
    }

    if (text.includes(SELL_EMPTY_MARKER)) {
        finishSellListAck('empty');
        return;
    }

    if (text.includes('[☃] Не удалось выставить')) {
        config.enoughItems = true;
        finishSellListAck('full');
        return;
    }

    if (text.includes('[✘] Ошибка! У Вас переполнено Хранилище!')) {
        config.enoughItems = false;
        config.needSell = true;
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

    // FunTime: «[☃] Вы пытаетесь выставить <item> слишком дорого! Введите команду продажи ещё раз, чтобы подтвердить!»
    if (
        text.includes('[☃] Вы пытаетесь выставить')
        && text.includes('слишком дорого! Введите команду продажи ещё раз, чтобы подтвердить!')
    ) {
        finishSellListAck('confirm');
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

        if (text.toLowerCase().includes('круш')) {
            finishSellListAck('retry');
            return;
        }

        parentPort.postMessage({ name: 'set_min_price', type: info.id, price: finalPrice });
        finishSellListAck('retry');
        return;
    }

    if (text.includes('BotFilter >> Введите номер с картинки в чат')) {
        if (captchaBusy) return;
        captchaBusy = true;
        parentPort.postMessage(`${workerData.username} - решаю капчу`);
        try {
            const solved = await handleCaptchaLogin(bot, {
                password: config.password,
                solverUrl: CAPTCHA_SOLVER_URL,
                username: config.username,
                log: (...a) => logInfo(a.join(' ')),
            });
            logOk(
                `капча принята ${solved.pred} conf=${solved.conf} try=${solved.attempt}`,
            );
            parentPort.postMessage(
                `${workerData.username} - капча ок ${solved.pred}`,
            );
        } catch (err) {
            logWarn(`капча fail: ${err?.message || err}`);
            parentPort.postMessage(`${workerData.username} - ввести капчу`);
        } finally {
            captchaBusy = false;
        }
        return;
    }

    // ретрай уже внутри handleCaptchaLogin; тут только не дублируем
    if (text.toLowerCase().includes('капчу неправильно')) {
        if (!captchaBusy) {
            logWarn('капча неправильно (нет активного solve)');
        }
        return;
    }

    if (
        text.includes('Зарегистрируйтесь')
        || text.includes('/reg <')
        || text.includes('/reg<')
    ) {
        if (captchaBusy) return;
        logInfo('сервер просит /reg');
        bot.chat(`/reg ${config.password}`);
        await rnd('BASE_DELAY');
        bot.chat(`/l ${config.password}`);
        return;
    }

    if (
        text.includes('Сначала авторизируйтесь')
        || text.includes('Авторизируйтесь')
        || text.includes('/l <')
        || text.includes('/login')
    ) {
        if (captchaBusy) return;
        logInfo('сервер просит /l');
        bot.chat(`/l ${config.password}`);
        return;
    }

    if (text.toLowerCase().includes('вы забанены')) {
        parentPort.postMessage({
            name: 'banned',
            username: workerData.username,
            reason: extractBanReason(text) || text,
        });
        return;
    }
    if (text.toLowerCase().includes('чтобы двигаться')) {
        funauthBindRequired = true;
        cancelFunauthVerifyTimer();
        parentPort.postMessage(`${workerData.username} - хуйня неведомая`);
        setTimeout(() => process.exit(0), 500);
        return;
    }
    if (
        text.toLowerCase().includes('подтвердите вход через')
        || (text.toLowerCase().includes('личные сообщения')
            && text.toLowerCase().includes('подтвердите'))
    ) {
        parentPort.postMessage({ name: 'funauth_2fa', username: workerData.username });
        parentPort.postMessage(`${workerData.username} - нужен 2fa (ВК/ТГ)`);
        setTimeout(() => process.exit(0), 500);
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
        maybeRestoreGoPresenceFromBalance();
        return;
    }
    if (text.includes(CLAN_TREASURY_LOW)) {
        if (foreignClanLeaveBusy || config.ownerBanDrain) {
            logWarn('казна: сумма больше баланса / пусто — глянем казну ещё раз');
            return;
        }
        if (!treasuryEmptyReported) {
            treasuryEmptyReported = true;
            logWarn('казна пуста → presence inactive для Go');
            parentPort.postMessage({ name: 'treasury_empty' });
        }
        config.needAdd = true;
        if (!config.hasDangerousTrash) await sellItems();
        await safeAH();
        return;
    }
    if (text.includes('[✘] Ошибка! У Вас не хватает Монет!')) {
        config.needAdd = true;
        if (!config.hasDangerousTrash) await sellItems();
        await safeAH();
        return;
    }
    if (isLobbyBroadcastMessage(text)) {
        if (Date.now() - botWorkerStartTime < LOBBY_IGNORE_MS) return;
        const preview = text.trim().length > 50 ? `${text.trim().slice(0, 50)}…` : text.trim();
        logWarn(`лобби «${preview}» → sellItems`);
        abortSellSession('лобби');
        cancelFunauthVerifyTimer();
        funauthBindRequired = false;
        config.timeJoinAnarchy = 0;
        await sellItems();
        return;
    }
}

parentPort.on('message', (data) => {
    if (data?.type === 'listing_res') {
        const cb = listingWait.get(data.reqId);
        if (cb) {
            listingWait.delete(data.reqId);
            cb(data.result);
        }
        return;
    }
    if (data?.type === 'warp_pick_res') {
        const cb = warpPickWait.get(data.reqId);
        if (cb) {
            warpPickWait.delete(data.reqId);
            cb(data.warp);
        }
        return;
    }
    if (data.type === 'price') {
        const nextItems = data.data;
        if (hasBotCategoryPriceChanged(config.items, nextItems)) {
            config.needReset = true;
            logInfo('цены Go → needReset (изменилась цена категории)');
        }
        config.items = nextItems;
        if (Array.isArray(data.catalogAll) && data.catalogAll.length) {
            config.catalogAll = data.catalogAll;
        }
        maybeRestoreGoPresenceFromBalance();
    }
    if (data.type === 'owner_banned') {
        if (!config.ownerBanDrain) {
            config.ownerBanDrain = true;
            generateKey();
            logWarn(
                `овнер забанен${data.owner ? ` (${data.owner})` : ''} → прерываю АХ, казна и leave`,
            );
        }
        return;
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
        version: '1.21.11',
        ...VANILLA_BOT_OPTS,
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
    setEnchantRegistry();
    patchWalking121(bot);
    installPlayerActionGate(bot);
    // карты капчи копятся сразу — к моменту строки BotFilter PNG уже почти готов
    attachMapCache(bot);

    setupConfigurationTransferFix(bot);
    attachWindowCloseTrace(bot);

    bot.once('inject_allowed', () => {
        setupChatSafeGuard(bot);
        applyVanillaClientSettings(bot);
    });

    // .
    bot.on('scoreboardCreated', (scoreboard) => {
        if (JSON.stringify(scoreboard).includes(`${config.anarchy}`)) {
            markAnarchyJoined();
        }
    });

    bot.on('kicked', (reason) => {
        const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
        console.error(`${logTag()} ${ANSI.red}⛔ kicked${ANSI.reset}: ${text}`);
        try {
            parentPort.postMessage({ name: 'kicked', reason: text });
        } catch { /* parent gone */ }
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
        bot.physicsEnabled = true;
        botWorkerStartTime = Date.now();
        logOk('spawn → /reg → /l → clan check → sellItems → safeAH');
        await rnd('BASE_DELAY');
        // тупо всегда: сначала reg, потом login (если уже зареган — сервер просто ответит)
        bot.chat(`/reg ${config.password}`);
        await rnd('BASE_DELAY');
        bot.chat(`/l ${config.password}`);
        config.timeJoinAnarchy = 0;
        await maybeLeaveForeignClan();
        await sellItems();
        await safeAH();
    });

    bot.on('physicTick', async () => {
        if (config.sellInFlight) {
            if (config.sellStartedAt && Date.now() - config.sellStartedAt > SELL_ITEMS_MAX_MS) {
                abortSellSession('таймаут');
            } else {
                return;
            }
        }
        if (config.ownerBanDrain) {
            config.timeActive = Date.now();
            await drainTreasuryAndLeaveClan();
            return;
        }
        if (Date.now() - config.timeActive > 60000) {
            // Не закрывать АХ «осмотром»: in-place reload не даёт windowOpen → timeActive не тикает.
            if (bot.currentWindow) {
                config.timeActive = Date.now();
                return;
            }
            config.timeActive = Date.now();
            await sellItems();
            if (!config.sellInFlight) await safeAH();
        }
    })

    bot.on('windowOpen', async () => {
        if (config.ownerBanDrain) {
            await closeCurrentWindowSafe();
            await drainTreasuryAndLeaveClan();
            return;
        }
        config.timeActive = Date.now();
        const key = generateKey();
        logInfo(`windowOpen → key …${String(key).slice(-6)}`);

        config.menu = resolveWindowMenu(bot.currentWindow);
        logInfo(`окно: ${config.menu}`);

        switch (config.menu) {
            case analysisAH: {
                // Reload без нового windowOpen: после паузы заново определяем окно и слоты.
                // Не жмём reload/page вслепую — вдруг это уже хранилище / подтверждение.
                const maxSameKeyPasses = 3;
                let staleAhReported = false;
                let staleContentPasses = 0;
                for (;;) {
                    if (config.ownerBanDrain) {
                        logWarn('АХ → овнер бан, выхожу');
                        await closeCurrentWindowSafe();
                        generateKey();
                        await drainTreasuryAndLeaveClan();
                        return;
                    }
                    if (config.key !== key) return;
                    config.timeActive = Date.now();
                    if (!bot.currentWindow) {
                        logWarn(
                            `АХ → GUI null (${lastWindowGone.why || '?'}) — жду open_window, не /ah`,
                        );
                        const waited = await waitForCurrentWindow(2500, key);
                        if (waited === 'newkey') return;
                        if (!bot.currentWindow) {
                            logWarn('АХ → open_window так и не пришёл — тогда /ah search');
                            await safeAH();
                            return;
                        }
                        logInfo('АХ → окно вернулось (это была дыра close→open, не «потеря»)');
                    }

                    config.menu = resolveWindowMenu(bot.currentWindow);
                    if (config.menu !== analysisAH) {
                        logInfo(`АХ-цикл → окно уже «${config.menu}», не жму reload`);
                        break;
                    }

                    // Сброс / инвентарь≥27 раньше sellItems — иначе осмотр съедает минуту или не даёт цикл снять→продать.
                    // enoughItems сюда НЕ входит: это «АХ забит при выставлении» — стоп sellItems, не повод лезть в хранилище.
                    if (
                        config.lastResetTime < Date.now() - 60000 ||
                        config.needReset ||
                        isBotInventoryFull()
                    ) {
                        logInfo(
                            isBotInventoryFull()
                                ? 'АХ → хранилище (инвентарь ≥27)'
                                : config.needReset
                                  ? 'АХ → хранилище (needReset)'
                                  : 'АХ → хранилище (timer60)',
                        );
                        config.menu = myItems;
                        await safeClickBuy(bot, slotToStorage, delayMs({ min: 1500, max: 4500 }), key);
                        return;
                    }

                    if (config.walkTime < Date.now() - (config.walkGapMs || 55_000) ||
                        (config.needSell && !config.enoughItems && hasBotItem())) {
                        logInfo('АХ → sellItems (осмотр/needSell)');
                        await sellItems();
                        if (config.key !== key) return;
                        if (!config.hasDangerousTrash) await safeAH();
                        return;
                    }

                    const slotToBuy = await getBestAHSlot();
                    if (config.key !== key) return;

                    if (slotToBuy !== null && slotToBuy <= lastBuyableAHSlot) {
                        const fakeSlot = Boolean(config.ahBuyFakeSlot);
                        config.ahBuyFakeSlot = false;
                        const buyWait = fakeSlot
                            ? ahFakeSlotBuyDelayMs()
                            : ahBuyDelayMs(slotToBuy);
                        logInfo(
                            fakeSlot
                                ? `АХ → купить слот ${slotToBuy} (низкая цена, ${buyWait}мс)`
                                : `АХ → купить слот ${slotToBuy}`,
                        );
                        const contentBeforeBuy = ahWindowContentKey(bot.currentWindow);
                        await safeClickBuy(
                            bot,
                            slotToBuy,
                            buyWait,
                            key,
                            true,
                        );
                        // Раньше тут был return → ждали windowOpen. FunTime часто обновляет
                        // АХ in-place после клика → бот мёртв до physicTick (~60с).
                        if (config.key !== key) return;
                        await rnd('WINDOW_DELAY');
                        if (config.key !== key) return;
                        if (!bot.currentWindow) {
                            const waited = await waitForCurrentWindow(2500, key);
                            if (waited === 'newkey') return;
                            if (!bot.currentWindow) {
                                logWarn(`АХ → после buy GUI нет (${lastWindowGone.why || '?'}) → /ah search`);
                                await safeAH();
                                return;
                            }
                        }
                        config.menu = resolveWindowMenu(bot.currentWindow);
                        if (config.menu !== analysisAH) {
                            logInfo(`АХ → после buy окно «${config.menu}»`);
                            break;
                        }
                        const contentAfterBuy = ahWindowContentKey(bot.currentWindow);
                        if (contentAfterBuy !== contentBeforeBuy) {
                            staleContentPasses = 0;
                            logInfo('АХ → buy in-place (слоты сменились, windowOpen нет)');
                        } else {
                            logInfo('АХ → после buy всё ещё Анализ, продолжаю цикл');
                        }
                        continue;
                    }

                    if (slotToBuy === null || config.needReloadAH) {
                        if (config.needReloadAH) config.needReloadAH = false;
                        logInfo(`АХ → browse (лот=${slotToBuy}, needReload=${config.needReloadAH})`);
                    } else {
                        logInfo(`АХ → browse (слот ${slotToBuy} вне диапазона)`);
                    }

                    const browse = pickAhBrowseAction();
                    logInfo(`АХ → reload ${browse.slot}`);

                    const contentBefore = ahWindowContentKey(bot.currentWindow);
                    await safeClickBuy(bot, browse.slot, delayMs({ min: 1500, max: 4500 }), key);
                    if (config.key !== key) return;

                    await rnd('WINDOW_DELAY');
                    if (config.key !== key) return;
                    if (!bot.currentWindow) {
                        const waited = await waitForCurrentWindow(2500, key);
                        if (waited === 'newkey') return;
                        if (!bot.currentWindow) {
                            logWarn(`АХ → после reload GUI нет (${lastWindowGone.why || '?'}) → /ah search`);
                            await safeAH();
                            return;
                        }
                    }

                    const contentAfter = ahWindowContentKey(bot.currentWindow);
                    if (contentAfter !== contentBefore) {
                        // FunTime часто обновляет АХ in-place без windowOpen — это не зависание
                        staleContentPasses = 0;
                        logInfo('АХ → reload in-place (слоты сменились, windowOpen нет)');
                        continue;
                    }

                    staleContentPasses += 1;
                    if (!staleAhReported && bot.currentWindow) {
                        staleAhReported = true;
                        reportStaleAhWindow(bot.currentWindow, {
                            pass: staleContentPasses,
                            maxSameKeyPasses,
                            contentSame: true,
                        });
                    }

                    if (staleContentPasses >= maxSameKeyPasses) {
                        logWarn(
                            `АХ → ${maxSameKeyPasses}× reload без смены слотов → safeAH`,
                        );
                        await safeAH();
                        return;
                    }

                    logInfo(
                        `АХ → слоты те же после reload (${staleContentPasses}/${maxSameKeyPasses})`,
                    );
                }

                if (config.key !== key) return;
                if (!bot.currentWindow) return;

                config.menu = resolveWindowMenu(bot.currentWindow);
                if (config.menu === accept) {
                    logInfo('окно → подтверждение покупки (клик glass)');
                    await safeClickBuy(bot, slotGlass, ahGlassDelayMs(), key);
                    return;
                }
                if (config.menu === rtp) {
                    await safeClickBuy(bot, 0, delayMs({ min: 1000, max: 3000 }), key);
                    config.needRTP = false;
                    config.hasDangerousTrash = false;
                    config.lastWarpTime = Date.now();
                    await sellItems();
                    await safeAH();
                    return;
                }
                if (config.menu !== myItems) {
                    return;
                }
                logInfo('АХ-цикл → обрабатываю как хранилище');
            }
            // fallthrough: меню стало «Хранилище» без нового windowOpen

            case myItems:
                config.needReset = false;
                await syncListingIdsFromStorageWindow();
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
                // Клик 52 только если прошло ≥60с — needReset сам по себе не форсит сброс
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

                // Инвентарь ≥27: после «снять всё» — продать всё; на АХ снова зайдём в хранилище, если ещё ≥27.
                if ((config.needSell || isBotInventoryFull()) && hasBotItem()) {
                    logInfo(
                        isBotInventoryFull()
                            ? 'хранилище → sellItems (инвентарь ≥27, продать всё)'
                            : 'хранилище → sellItems',
                    );
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
                await safeClickBuy(bot, slotGlass, ahGlassDelayMs(), key);
                break;
        }
        await rnd('WINDOW_DELAY');
        if (key === config.key) {
            logInfo('windowOpen → конец (key не изменился)');
            return;
        }
        logInfo(`windowOpen → конец (${config.menu})`);
    });
}

main();

async function joinAnarchy(gen = null) {
    for (;;) {
        if (gen != null && !isSellSessionAlive(gen)) return;
        if (!config.timeJoinAnarchy) {
            while (!config.timeJoinAnarchy) {
                if (gen != null && !isSellSessionAlive(gen)) return;
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
                // physics не гасим навсегда: только configuration-фаза сама выключает
                bot.chat(`/an${config.anarchy}`);
                await rnd('ANARCHY_DELAY');
            }
        }
        const joinedAt = config.timeJoinAnarchy;
        if (!joinedAt) continue;
        const waitUntil = joinedAt + 11000;
        if (Date.now() < waitUntil) {
            logInfo(`joinAnarchy → пауза ${Math.ceil((waitUntil - Date.now()) / 1000)}с`);
            while (Date.now() < waitUntil) {
                if (gen != null && !isSellSessionAlive(gen)) return;
                // Выкинуло в лобби — timeJoin сброшен, заново /an
                if (!config.timeJoinAnarchy || config.timeJoinAnarchy !== joinedAt) break;
                await rnd('POLL');
            }
        }
        if (config.timeJoinAnarchy && config.timeJoinAnarchy === joinedAt) return;
    }
}

async function waitChatFlag(pred, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (pred()) return true;
        await sleepMs(400);
    }
    return pred();
}

async function refreshPersonalBalance(waitMs = 12_000) {
    config.balance = null;
    const deadline = Date.now() + waitMs;
    while (config.balance == null && Date.now() < deadline) {
        if (!bot?.chat) return null;
        bot.chat('/balance');
        await rnd('BASE_DELAY');
    }
    return config.balance;
}

async function refreshClanTreasury(waitMs = 12_000) {
    clanTreasuryBal = null;
    const deadline = Date.now() + waitMs;
    let triedBalance = false;
    while (clanTreasuryBal == null && Date.now() < deadline) {
        if (!bot?.chat) return null;
        bot.chat('/clan money');
        await rnd('BASE_DELAY');
        if (clanTreasuryBal == null && !triedBalance) {
            triedBalance = true;
            bot.chat('/clan balance');
            await rnd('BASE_DELAY');
        }
    }
    return clanTreasuryBal;
}

/** Казна (лимит 2.5 млрд) и /clan leave true. skipIfOurClan — старт: свой овнер не трогаем. */
async function drainTreasuryAndLeaveClan({ skipIfOurClan = false } = {}) {
    if (!bot?.chat) return;
    if (config.ownerBanLeaveDone) return;
    foreignClanLeaveBusy = true;
    notInClanHint = false;
    clanLeaderNick = null;
    clanMembersList = null;
    clanTreasuryBal = null;
    selfWithdrawSeen = false;
    pendingClanLeaveConfirm = null;
    try {
        await joinAnarchy();
        logInfo('/clan info…');
        bot.chat('/clan info');
        await waitChatFlag(() => Boolean(clanLeaderNick || notInClanHint), 12_000);
        if (notInClanHint) {
            logInfo('клана нет — leave skip');
            if (config.ownerBanDrain) config.ownerBanLeaveDone = true;
            return;
        }
        if (!clanLeaderNick) {
            logWarn('/clan info — нет лидера, leave skip');
            return;
        }
        if (skipIfOurClan) {
            const owner = expectedClanOwnerNick();
            if (!owner) {
                logWarn(`an${config.anarchy}: нет username в clan-owners.json — leave skip`);
                return;
            }
            logInfo(`клан лидер ${clanLeaderNick} (ожидаем ${owner})`);
            if (clanLeaderNick.toLowerCase() === owner.toLowerCase()) return;
            logWarn(`чужой клан → казна → leave`);
        } else {
            logWarn(`казна → leave (овнер бан / принудительно)`);
        }

        for (let attempt = 1; attempt <= 4; attempt++) {
            const personal = await refreshPersonalBalance();
            const room = MAX_PERSONAL_BALANCE - (Number.isFinite(personal) ? personal : 0);
            if (room <= 0) {
                logWarn(`личный баланс ${personal} ≥ ${MAX_PERSONAL_BALANCE} — снимать некуда`);
                break;
            }
            let treasury = await refreshClanTreasury();
            if (treasury == null) {
                logWarn('казна: нет ответа');
                break;
            }
            if (treasury <= 0) {
                logInfo('казна пуста');
                break;
            }
            const take = Math.min(treasury, room);
            selfWithdrawSeen = false;
            logInfo(`попытка ${attempt}: /clan withdraw ${take} (казна ${treasury}, место ${room})`);
            bot.chat(`/clan withdraw ${take}`);
            const ok = await waitChatFlag(() => selfWithdrawSeen, 10_000);
            if (ok) {
                const after = Number.isFinite(config.balance) ? config.balance + take : null;
                if (after != null) config.balance = after;
                continue;
            }
            logWarn('нет «Игрок … снял $… из казны» — ещё раз казна');
            await refreshClanTreasury();
        }

        pendingClanLeaveConfirm = null;
        logInfo('/clan leave');
        bot.chat('/clan leave');
        await waitChatFlag(() => Boolean(pendingClanLeaveConfirm), 8_000);
        const confirm = pendingClanLeaveConfirm || '/clan leave true';
        logInfo(confirm);
        bot.chat(confirm);
        await rnd('BASE_DELAY');
        if (config.ownerBanDrain) config.ownerBanLeaveDone = true;
    } finally {
        foreignClanLeaveBusy = false;
    }
}

async function maybeLeaveForeignClan() {
    await drainTreasuryAndLeaveClan({ skipIfOurClan: true });
}

function isSellSessionAlive(gen) {
    if (gen !== config.sellGen) return false;
    if (config.sellStartedAt && Date.now() - config.sellStartedAt > SELL_ITEMS_MAX_MS) {
        return false;
    }
    return true;
}

function abortSellSession(reason) {
    config.sellGen += 1;
    config.sellInFlight = false;
    config.sellStartedAt = 0;
    logWarn(`продажа → прервана (${reason})`);
}

async function waitWarpTeleport() {
    while (Date.now() - config.lastWarpTime < 7500) await rnd('POLL');
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

async function closeCurrentWindowSafe() {
    const win = bot?.currentWindow;
    if (!win) return;
    await rnd('BASE_DELAY');
    if (bot?.currentWindow !== win) return;
    try {
        await bot.closeWindow(win);
    } catch (err) {
        reportError('closeWindow', err);
    }
}

async function sellItems() {
    if (config.sellInFlight) {
        if (config.sellStartedAt && Date.now() - config.sellStartedAt > SELL_ITEMS_MAX_MS) {
            abortSellSession('таймаут');
        } else {
            logWarn('продажа → уже идёт, skip');
            return;
        }
    }
    const gen = config.sellGen;
    config.sellInFlight = true;
    config.sellStartedAt = Date.now();
    config.timeActive = Date.now();
    logOk('продажа → старт');
    try {
        if (config.ownerBanDrain) {
            await drainTreasuryAndLeaveClan();
            return;
        }
        config.needSell = false;
        config.needSendAH = true;
        await joinAnarchy(gen);
        if (!isSellSessionAlive(gen)) {
            logWarn('продажа → abort после joinAnarchy');
            return;
        }
        config.timeActive = Date.now();
        let canSell = true;

        if (!bot) {
            reportError('sellItems', 'bot не создан');
            canSell = false;
        } else if (!Array.isArray(config.items)) {
            config.items = [];
            logWarn('каталог не массив → [] (Go выкл?) — гуляем без выставления');
        } else if (!config.items.length) {
            logWarn('каталог пуст (Go выкл?) — гуляем без выставления');
        }

        if (!canSell) logWarn('продажа → пропуск (нет бота)');

        if (bot) {
            await closeCurrentWindowSafe();
            if (!isSellSessionAlive(gen)) return;
            if (
                shouldAttemptWarp(
                    config.username,
                    config.lastWarpTime || 0,
                    botWorkerStartTime,
                )
            ) {
                const warp = await pickWarpForSession();
                if (warp && isSellSessionAlive(gen)) {
                    await rnd('BASE_DELAY');
                    if (!isSellSessionAlive(gen)) return;
                    logInfo(
                        `warp → ${warp}${config.lastWarp ? ` (был ${config.lastWarp})` : ''}`,
                    );
                    bot.chat(`/warp ${warp}`);
                    config.lastWarp = warp;
                    config.lastWarpTime = Date.now();
                    // lookAroundSpin сам ждёт flush chat + паузу после команды
                }
            }

            await lookAroundSpin(() => !isSellSessionAlive(gen));
            if (!isSellSessionAlive(gen)) return;
            await dropTrash();
        }

        if (canSell) {
            await moveToHotBar();
            if (!isSellSessionAlive(gen)) return;

            let currentSlot = firstHotbarSlot;
            while (
                hasBotItem()
                && !config.enoughItems
                && currentSlot <= lastHotbarSlot
                && !config.hasDangerousTrash
                && isSellSessionAlive(gen)
                && !config.ownerBanDrain
            ) {
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

                // Чужая категория — не продаём и не выбрасываем
                if (info?.isForeignCategory) {
                    currentSlot++;
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
                    const slotGone = () => sellSlotIsEmpty(currentSlot);
                    if (bot.quickBarSlot !== quick) {
                        if (!await rndPoll('HOTBAR_DELAY', 100, slotGone)) {
                            logInfo(`sellItems slot=${currentSlot} → слот пуст до hotbar`);
                            currentSlot++;
                            continue;
                        }
                        await bot.setQuickBarSlot(quick);
                    }
                    // hotbar → пауза → осмотр (если AFK) → sell; без наложений
                    if (bot.quickBarSlot === quick) {
                        await sleepMs(180 + Math.floor(Math.random() * 320));
                    }
                    await antiAfkIfNeeded(() => !isSellSessionAlive(gen));
                    if (!isSellSessionAlive(gen)) return;
                    if (slotGone()) {
                        logInfo(`sellItems slot=${currentSlot} → слот пуст после AFK`);
                        currentSlot++;
                        continue;
                    }
                    if (!await rndPoll('BASE_DELAY', 100, slotGone)) {
                        logInfo(`sellItems slot=${currentSlot} → слот пуст до sell`);
                        currentSlot++;
                        continue;
                    }
                    if (slotGone()) {
                        logInfo(`sellItems slot=${currentSlot} → слот пуст, sell пропущен`);
                        currentSlot++;
                        continue;
                    }
                    let sellPrice = config.needPrice || info.sellPrice;
                    if (config.needPrice) config.needPrice = 0;
                    // Слот на месте → повторяем /ah sell (confirm «слишком дорого», мин/макс, глюк чата)
                    for (let attempt = 1; attempt <= SELL_SLOT_MAX_ATTEMPTS; attempt++) {
                        if (!isSellSessionAlive(gen)) return;
                        if (slotGone() || config.enoughItems || config.hasDangerousTrash) break;
                        if (config.needPrice) {
                            sellPrice = config.needPrice;
                            config.needPrice = 0;
                        }
                        let alloc = null;
                        try {
                            const held = bot.inventory.slots[currentSlot];
                            const meta = snapshotItemTradeMeta(held);
                            alloc = await listingOp('alloc', {
                                sellPrice,
                                catalogId: info.id,
                                enchants: meta.enchants,
                                durability: meta.durability,
                            });
                        } catch (e) {
                            logWarn(`sellItems listing alloc: ${e.message}`);
                            break;
                        }
                        const listingId = alloc?.listingId;
                        const listPrice = alloc?.listPrice;
                        if (listingId == null || !Number.isFinite(listPrice)) {
                            logWarn(`sellItems slot=${currentSlot} → нет свободного listing id 0–4`);
                            config.enoughItems = true;
                            break;
                        }
                        await waitForEventLoopOk({ log: (m) => logWarn(m) });
                        await waitActionsSettled(() => !isSellSessionAlive(gen));
                        if (!isSellSessionAlive(gen)) return;
                        bot.chat(`/ah sell ${listPrice}`);
                        await chatChain;
                        let ack = await waitSellListAck();
                        if (!isSellSessionAlive(gen)) return;
                        if (ack === 'timeout') {
                            if (config.needPrice) ack = 'retry';
                            else if (config.enoughItems) ack = 'full';
                            else if (!slotGone()) ack = 'confirm';
                        }
                        if (ack !== 'ok') {
                            try {
                                await listingOp('clearPending');
                            } catch {
                                /* ignore */
                            }
                        }
                        if (ack === 'ok') {
                            logOk(`sellItems slot=${currentSlot} → выставлен id=${listingId} price=${listPrice}`);
                            break;
                        }
                        if (ack === 'empty' || ack === 'skip') {
                            logInfo(
                                `sellItems slot=${currentSlot} → ${ack === 'empty' ? 'пусто (Воздух)' : 'пропуск'}`,
                            );
                            break;
                        }
                        if (ack === 'full') {
                            logInfo(`sellItems slot=${currentSlot} → АХ/хранилище забито`);
                            break;
                        }
                        if (ack === 'retry' || ack === 'confirm') {
                            logInfo(
                                `sellItems slot=${currentSlot} → повтор ${attempt}/${SELL_SLOT_MAX_ATTEMPTS} (${ack})`,
                            );
                            if (attempt < SELL_SLOT_MAX_ATTEMPTS && !slotGone()) {
                                await rnd('BASE_DELAY');
                                continue;
                            }
                            break;
                        }
                        logInfo(`sellItems slot=${currentSlot} → ack ${ack}`);
                        break;
                    }
                    currentSlot++;
                } catch (err) {
                    reportError(`sellItems ah sell slot=${currentSlot}`, err);
                    finishSellListAck('error');
                    currentSlot++;
                }
            }
            if (config.ownerBanDrain) {
                await drainTreasuryAndLeaveClan();
            } else if (!config.hasDangerousTrash && isSellSessionAlive(gen)) {
                await safeBalance();
                const saveSum = getSaveSum();
                if (saveSum != null && config.balance != null && config.balance > saveSum) {
                    const investSum = config.balance - saveSum;
                    if (investSum > 5_000_000) {
                        const since = Date.now() - (config.lastClanInvestAt || 0);
                        if (since < CLAN_INVEST_COOLDOWN_MS) {
                            logInfo(
                                `clan invest cooldown ещё ${Math.ceil((CLAN_INVEST_COOLDOWN_MS - since) / 1000)}с`,
                            );
                        } else {
                            await rnd('AH_CMD');
                            bot.chat(`/clan invest ${investSum}`);
                            config.lastClanInvestAt = Date.now();
                        }
                    }
                }
                if (saveSum != null && config.balance != null && config.balance < saveSum / 2) {
                    const withdrawSum = Math.floor(saveSum / 2 - config.balance);
                    if (withdrawSum > 0) {
                        bot.chat(`/clan withdraw ${withdrawSum}`);
                        config.needAdd = false;
                    }
                }
            }
        }

    } catch (err) {
        reportError('sellItems', err);
        if (isSellSessionAlive(gen)) await waitWarpTeleport();
    } finally {
        config.needSell = false;
        if (gen === config.sellGen) {
            await waitWarpTeleport();
            config.timeActive = Date.now();
            config.sellInFlight = false;
            config.sellStartedAt = 0;
            logOk('продажа → конец');
        } else {
            logWarn('продажа → конец (устаревшая сессия)');
        }
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
                if (isBotTradeItem(invInfo)) {
                    if (!isStorageSlot(src) || !isHotbarSlot(slot)) {
                        reportError('moveToHotBar', `недопустимый перенос ${src}→${slot}`);
                        break;
                    }
                    try {
                        await waitForEventLoopOk({ log: (m) => logWarn(m) });
                        await waitActionsSettled();
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
            if (isBotTradeItem(info)) return true;
        }
        return false;
    } catch (err) {
        reportError('hasBotItem', err);
        return false;
    }
}

/** Сколько слотов 9–40 занято предметами каталога бота (не мусор). */
function countBotCatalogInventorySlots() {
    if (!bot?.inventory?.slots) return 0;
    let count = 0;
    for (let i = botInventoryTrackFirstSlot; i <= botInventoryTrackLastSlot; i++) {
        const info = getSlotInfoSafe(bot.inventory.slots[i], i);
        if (isBotTradeItem(info)) count++;
    }
    return count;
}

/** true — занято ≥27 из 32 слотов (9–40) предметами go-типа бота. */
function isBotInventoryFull() {
    try {
        return countBotCatalogInventorySlots() >= botInventoryFullThreshold;
    } catch (err) {
        reportError('isBotInventoryFull', err);
        return false;
    }
}

/** Anti-AFK: микро мышь + одна WASD (как рабочий FunTime-клиент). */
async function lookAroundSpin(shouldAbort = null) {
    if (!(await pauseAfterChatBeforeLook(shouldAbort))) return;
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    await waitForEventLoopOk({ log: (m) => logWarn(m) });
    const prevPhysics = bot.physicsEnabled;
    ensurePhysicsOn(bot);
    lookLock = true;
    try {
        await runAntiAfkMotion(bot, (msg) => logOk(msg), shouldAbort, { force: Boolean(config.afk) });
    } finally {
        try {
            for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
                bot.setControlState(key, false);
            }
        } catch {
            /* ignore */
        }
        lookLock = false;
        lastLookAt = Date.now();
        // не возвращаем false — physics держим как у живого клиента
        if (prevPhysics === false && isInConfigurationTransfer()) {
            bot.physicsEnabled = false;
        } else {
            ensurePhysicsOn(bot);
        }
    }
    const after = 220 + Math.floor(Math.random() * 380);
    const deadline = Date.now() + after;
    while (Date.now() < deadline) {
        if (typeof shouldAbort === 'function' && shouldAbort()) break;
        await sleepMs(Math.min(50, deadline - Date.now()));
    }
    config.walkTime = Date.now();
    config.walkGapMs = nextWalkGapMs();
}

/** Сход с AFK — тот же motion (force через config.afk). */
async function antiAfkIfNeeded(shouldAbort = null) {
    if (!config.afk) return;
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    logAfk('сходу с AFK → motion');

    await closeCurrentWindowSafe();

    await lookAroundSpin(shouldAbort);
    config.afk = false;
    logOk('AFK снят');
}

/** Пока ключ не сменился (открылось окно АХ) — одно движение и `/ah search`. */
async function safeAH() {
    if (config.ownerBanDrain) {
        await drainTreasuryAndLeaveClan();
        return;
    }
    logOk('safeAH → старт');
    if (!bot) return;
    if (bot.currentWindow) logInfo('safeAH → закрываю окно');
    await closeCurrentWindowSafe();
    await joinAnarchy();
    await rnd('BASE_DELAY');

    config.needReloadAH = true;
    config.menu = analysisAH;
    config.botUpdateWindow = true;
    const key = config.key;

    let searchCount = 0;
    while (key === config.key) {
        if (config.ownerBanDrain) {
            await drainTreasuryAndLeaveClan();
            return;
        }
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
    await closeCurrentWindowSafe();
    await joinAnarchy();
    await rnd('BASE_DELAY');

    config.botUpdateWindow = true;

    while (config.balance === null) {
        if (config.ownerBanDrain) return;
        await antiAfkIfNeeded();
        await rnd('AH_CMD');
        config.menu = analysisAH;
        bot.chat(`/balance`);
        await rnd('POLL');
    }
}


/**
 * Первый выгодный слот слева направо (0–17).
 */
async function getBestAHSlot() {
    try {
        if (!bot?.currentWindow?.slots) return null;
        let buyItem = null;
        try {
            for (let slot = firstAHSlot; slot <= lastAHSlot; slot++) {
            const slotData = bot.currentWindow.slots[slot];
            if (!slotData) continue;

            let currentUUID = null;
            try {
                currentUUID = getItemUUID(slotData);
            } catch (err) {
                reportSlotError(`getItemUUID slot=${slot}`, err, slotData);
                continue;
            }

            if (currentUUID && isUuidBlockedByOther(itemsBuying, currentUUID, config.username)) {
                continue;
            }

            const info = getSlotInfoSafe(slotData, slot);
            if (!info || info.isTrash || info.isForeignCategory || !info.id || !info.buyPrice) continue;

            let ahPrice;
            try {
                ahPrice = getPriceFromAhItem(slotData);
            } catch (err) {
                reportSlotError(`getPriceFromAh slot=${slot}`, err, slotData);
                continue;
            }

            if (ahPrice >= info.buyPrice) continue;

            const fakeSlot = ahPrice <= AH_FAKE_SLOT_PRICE_MAX;

            config.BuyingItem.id = info.id;
            config.BuyingItem.price = ahPrice;
            config.BuyingItem.buyPrice = info.buyPrice;
            config.BuyingItem.nacenka = info.nacenka;
            const buyMeta = snapshotItemTradeMeta(slotData);
            config.BuyingItem.enchants = buyMeta.enchants;
            config.BuyingItem.durability = buyMeta.durability;

            if (currentUUID) claimAhLotUuid(currentUUID);

            config.ahBuyFakeSlot = fakeSlot;
            buyItem = slotData;
            return slot;
            }

            config.ahBuyFakeSlot = false;
            return null;
        } finally {
            flushAhBookLots(buyItem);
        }
    } catch (err) {
        config.ahBuyFakeSlot = false;
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