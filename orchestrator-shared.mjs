import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mergeBuyingClaim, mergeGoJsonUpdate, uuidForGoBroadcast } from './items-buying-coord.mjs';
import { catalogTypeMatchesGoType } from './lib/go-type.mjs';

const execFileAsync = promisify(execFile);

const ORCH_ROOT = dirname(fileURLToPath(import.meta.url));
const CLAN_SETUP_SCRIPT = join(ORCH_ROOT, 'scripts', 'clan-setup.mjs');
/** Не чаще одного запуска на анархию раз в 3 минуты (от предыдущего start) */
const CLAN_SETUP_COOLDOWN_MS = 3 * 60 * 1000;
/** anarchy → { child?, startedAt?, finishedAt? } */
const clanSetupByAnarchy = new Map();

/**
 * Запуск scripts/clan-setup.mjs <an>.
 * myNick берётся из clan-owners.json (корневой myNick / per-an myNick).
 * Дедуп: один процесс на анархию + не чаще раза в 3 мин.
 */
export function requestClanSetup({ anarchy, reason, username }, ctx) {
    const an = String(anarchy ?? '').replace(/\D/g, '').slice(0, 3);
    if (!/^\d{3}$/.test(an)) {
        console.warn(`[clan-setup] bad anarchy from ${username}: ${anarchy}`);
        return false;
    }
    const now = Date.now();
    const cur = clanSetupByAnarchy.get(an);
    if (cur?.child && cur.child.exitCode == null && !cur.child.killed) {
        console.log(`[clan-setup] an${an} уже запущен (триггер ${username}, reason=${reason})`);
        return false;
    }
    if (cur?.startedAt && now - cur.startedAt < CLAN_SETUP_COOLDOWN_MS) {
        const left = Math.ceil((CLAN_SETUP_COOLDOWN_MS - (now - cur.startedAt)) / 1000);
        console.log(`[clan-setup] an${an} cooldown ещё ${left}с (триггер ${username})`);
        return false;
    }

    console.log(`[clan-setup] start an${an} reason=${reason} trigger=${username}`);
    try {
        ctx?.sendAlert?.(
            `⚔ clan-setup an${an}: ${reason} ← ${username}`,
            username,
        );
    } catch {
        /* ignore */
    }

    const child = spawn(process.execPath, [CLAN_SETUP_SCRIPT, an], {
        cwd: ORCH_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
    });
    clanSetupByAnarchy.set(an, { child, startedAt: now });

    const prefix = `[clan-setup an${an}]`;
    const pipe = (stream, write) => {
        let buf = '';
        stream?.on('data', (chunk) => {
            buf += String(chunk);
            const parts = buf.split('\n');
            buf = parts.pop() || '';
            for (const line of parts) {
                if (line) write(`${prefix} ${line}`);
            }
        });
        stream?.on('end', () => {
            if (buf) write(`${prefix} ${buf}`);
        });
    };
    pipe(child.stdout, console.log);
    pipe(child.stderr, console.error);

    child.on('error', (err) => {
        console.error(`${prefix} spawn error: ${err.message}`);
        clanSetupByAnarchy.set(an, { startedAt: now, finishedAt: Date.now() });
    });
    child.on('exit', (code, signal) => {
        console.log(`${prefix} exit code=${code} signal=${signal || '-'}`);
        clanSetupByAnarchy.set(an, { startedAt: now, finishedAt: Date.now() });
    });
    return true;
}

/**
 * Общая логика оркестраторов: каталог с Go, активные типы, цены.
 *
 * Старая/новая броня в одном items_config.json:
 * — отдельные piece-типы: netherite_helmet-1.21, …
 * — позорная: "позорная-броня-1.21"
 * — an503: goType "netherite_armor-1.21" — все piece-типы кроме позорной
 * Матч: catalogTypeMatchesGoType(catalog.type, bot.goType).
 */

/** Окно сбора мин. цен на АХ перед отправкой в Go */
export const MARKET_FLOOR_WINDOW_MS = 10 * 60 * 1000;
export const MARKET_FLOOR_CHECK_MS = 30 * 1000;
/** Допуск на джиттер таймеров (воркер / оркестратор / сеть) */
export const MARKET_FLOOR_WINDOW_SLACK_MS = 5000;

export const GO_WS_URL_REMOTE = 'ws://212.8.229.76:8080/ws';
export const GO_WS_URL_LOCAL = 'ws://127.0.0.1:8080/ws';

/** Go WebSocket: GO_WS_URL env > LOCAL_MODE > VPS по умолчанию */
export function resolveGoWebSocketUrl(localMode = false) {
    if (process.env.GO_WS_URL) return process.env.GO_WS_URL;
    if (localMode || process.env.LOCAL_MODE === '1' || process.env.LOCAL_MODE === 'true') {
        return GO_WS_URL_LOCAL;
    }
    return GO_WS_URL_REMOTE;
}

export function sendMarketFloorsToGo(socket, isOpen, floors, meta) {
    if (!socket || !isOpen || !floors || Object.keys(floors).length === 0) return false;
    if (!meta?.window_start_ms || !meta?.window_end_ms) return false;
    const span = meta.window_end_ms - meta.window_start_ms;
    if (span < MARKET_FLOOR_WINDOW_MS - MARKET_FLOOR_WINDOW_SLACK_MS) return false;
    socket.send(JSON.stringify({
        action: 'ah_market_floor',
        floors,
        window_start_ms: meta.window_start_ms,
        window_end_ms: meta.window_end_ms,
        window_ms: MARKET_FLOOR_WINDOW_MS,
    }));
    return true;
}

/** AH search в боте (human) → go type для сервера */
export const ITEM_TO_GO_TYPE = {
    'netherite sword': 'netherite_sword-1.21',
    'netherite leggings': 'netherite_leggings-1.21',
    'netherite chestplate': 'netherite_chestplate-1.21',
    'netherite helmet': 'netherite_helmet-1.21',
    'netherite boots': 'netherite_boots-1.21',
    'netherite armor': 'позорная-броня-1.21',
    'netherite armour': 'позорная-броня-1.21',
    'netherite pickaxe': 'netherite_pickaxe-1.21',
    'отдача': 'отдача-1.21',
    'elytra': 'elytra-1.21',
};

export function resolveGoType(bot) {
    if (bot.goType) return bot.goType;
    const key = (bot.item || '').toLowerCase().trim();
    return ITEM_TO_GO_TYPE[key] || null;
}

export function mergeCatalogWithPrices(catalog, prices) {
    if (!Array.isArray(catalog) || !prices) return [];
    return catalog
        .map((item) => ({
            ...item,
            priceSell: prices[item.id],
        }))
        .filter((item) => item.priceSell !== undefined);
}

/** Предметы для воркера: только его go-тип */
export function itemPricesForBot(catalog, prices, goType) {
    if (!goType) return [];
    return mergeCatalogWithPrices(catalog, prices).filter((item) => catalogTypeMatchesGoType(item.type, goType));
}

/** Успешные воркеры → типы для Go (без id предметов) */
/** Все go-типы из bots.json (чем этот оркестратор может торговать) */
export function collectFleetTypes(bots) {
    const types = new Set();
    for (const bot of bots.values()) {
        const goType = resolveGoType(bot);
        if (goType) types.add(goType);
    }
    return [...types];
}

/** Живые боты по go-типу (для ML / Go) */
export function collectBotsPerType(bots, workers) {
    const counts = {};
    for (const [username, workerData] of workers) {
        if (!isBotAliveForPresence(username, bots, workers)) continue;
        const bot = bots.get(username);
        const goType = resolveGoType(bot);
        if (!goType) continue;
        counts[goType] = (counts[goType] || 0) + 1;
    }
    return counts;
}

export function buildPresencePayload(bots, workers, botItems, botInventory, extraOrOpts = []) {
    const opts = Array.isArray(extraOrOpts)
        ? { extraBanned: extraOrOpts, clanOwners: [] }
        : (extraOrOpts && typeof extraOrOpts === 'object' ? extraOrOpts : {});
    const extraBanned = opts.extraBanned || [];
    const clanOwners = opts.clanOwners || [];
    const presence = collectPresenceItemCounts(bots, workers, botItems, botInventory);
    return {
        action: 'presence',
        items: presence.items,
        inventory: presence.inventory,
        active_types: collectActiveTypes(bots, workers),
        bots_per_type: collectBotsPerType(bots, workers),
        banned: collectBannedBots(bots, extraBanned),
        clan_owners: clanOwners,
    };
}

/** Забаненные аккаунты для Go /fleet (ник + анархия). */
export function collectBannedBots(bots, extraBanned = []) {
    const out = [];
    if (bots) {
        for (const bot of bots.values()) {
            if (!bot?.banned) continue;
            out.push({
                username: bot.username,
                anarchy: bot.anarchy ?? null,
                go_type: resolveGoType(bot) || bot.goType || '',
                banned_at: bot.bannedAt || null,
                reason: bot.banReason || '',
            });
        }
    }
    for (const b of extraBanned || []) {
        if (!b?.username) continue;
        out.push({
            username: b.username,
            anarchy: b.anarchy ?? null,
            go_type: b.go_type || '',
            banned_at: b.banned_at || b.bannedAt || null,
            reason: b.reason || b.banReason || '',
        });
    }
    out.sort((a, b) => {
        const aa = Number(a.anarchy) || 0;
        const ba = Number(b.anarchy) || 0;
        if (aa !== ba) return aa - ba;
        return String(a.username).localeCompare(String(b.username));
    });
    return out;
}

/** Кик с экрана дисконнекта: бан / blacklist, а не «ник уже онлайн». */
export function isBanKickReason(reason) {
    const s = String(reason || '').toLowerCase();
    if (!s) return false;
    if (s.includes('ником уже онлайн') || s.includes('таким-же ником') || s.includes('already online')) {
        return false;
    }
    return (
        s.includes('забанен')
        || s.includes('заблокирован')
        || s.includes('banned')
        || s.includes('blacklist')
        || s.includes('blacklisted')
        || /\bban\b/.test(s)
    );
}

export async function handleWorkerKicked(username, reason, ctx) {
    const bot = ctx.bots?.get(username);
    if (bot) bot.lastKickReason = String(reason || '');
    if (isBanKickReason(reason)) {
        await markBotBanned(username, ctx, reason);
        return true;
    }
    return false;
}

export function collectActiveTypes(bots, workers) {
    const types = new Set();
    for (const username of workers.keys()) {
        if (!isBotAliveForPresence(username, bots, workers)) continue;
        const bot = bots.get(username);
        const goType = resolveGoType(bot);
        if (goType) types.add(goType);
    }
    return [...types];
}

/** Бот считается «живым» для presence, active_types и слотов в ценообразовании */
export function isBotAliveForPresence(username, bots, workers) {
    const workerData = workers.get(username);
    const bot = bots.get(username);
    return !!(
        workerData?.worker
        && !workerData.worker.terminated
        && bot?.success
        && !bot.presenceInactive
    );
}

/**
 * Мягко убрать бота из Go presence (слоты/типы), не останавливая воркер.
 * Как бан для ценообразования; снимается только через clearBotPresenceInactive.
 */
export function markBotPresenceInactive(username, ctx, reason = 'presence_inactive') {
    const bot = ctx.bots?.get(username);
    if (!bot || bot.presenceInactive) return false;
    bot.presenceInactive = true;
    clearBotPresence(username, ctx.botItems, ctx.botInventory);
    ctx.pushPresenceToGo?.();
    console.log(`[presence] ${username} inactive (${reason}) — слоты не в ценообразовании`);
    return true;
}

/** Снять presence-inactive (баланс снова в норме) и снова учесть слоты в Go. */
export function clearBotPresenceInactive(username, ctx, reason = 'presence_ok') {
    const bot = ctx.bots?.get(username);
    if (!bot?.presenceInactive) return false;
    bot.presenceInactive = false;
    ctx.pushPresenceToGo?.();
    console.log(`[presence] ${username} active again (${reason})`);
    return true;
}

export function clearBotPresence(username, botItems, botInventory) {
    botItems.delete(username);
    botInventory.delete(username);
}

/** Статус для /ping: в игре ≠ просто запущенный воркер */
export function getWorkerHealthStats(bots, workers) {
    const banned = [];
    const waiting = [];
    let active = 0;
    let workersRunning = 0;

    for (const bot of bots.values()) {
        const username = bot.username;
        const entry = workers.get(username);
        const hasWorker = !!(entry?.worker && !entry.worker.terminated);
        if (hasWorker) workersRunning++;

        if (bot.banned) {
            banned.push(username);
            continue;
        }
        if (bot.success && hasWorker) {
            active++;
        } else if (hasWorker) {
            waiting.push(username);
        }
    }

    return {
        configured: bots.size,
        active,
        workersRunning,
        banned,
        waiting,
    };
}

export function formatBotLabel(username, bots) {
    const anarchy = bots?.get(username)?.anarchy;
    if (anarchy != null && anarchy !== '') {
        return `${anarchy} ${username}`;
    }
    return username;
}

/** Вставляет номер анархии перед username в тексте алерта. */
export function formatBotAlert(username, message, bots) {
    const text = String(message ?? '');
    const label = formatBotLabel(username, bots);
    if (label === username) {
        return text.includes(username) ? text : `${username}: ${text}`;
    }
    const idx = text.indexOf(username);
    if (idx >= 0) {
        return text.slice(0, idx) + label + text.slice(idx + username.length);
    }
    return `${label}: ${text}`;
}

const ALERT_MENTION_HANDLE = 'sasha_pshonko';
const ALERT_MENTION_COOLDOWN_MS = 60 * 60 * 1000;
const alertMentionCooldownUntil = new Map();

export const ALERT_KIND = {
    BAN: 'ban',
    CAPTCHA: 'captcha',
    VPN: 'vpn',
    UNKNOWN: 'unknown',
};

/** Тип алерта для @тега (бан / капча / vpn / неведомая). */
export function classifyWorkerAlert(message) {
    if (message == null) return null;
    const lower = String(message).toLowerCase();
    if (lower.includes('забанен')) return ALERT_KIND.BAN;
    if (lower.includes('ввести капчу') || lower.includes('капч')) return ALERT_KIND.CAPTCHA;
    if (lower.includes('vpn спалили') || lower.includes('впн спалили')) return ALERT_KIND.VPN;
    if (lower.includes('хуйня неведомая') || lower.includes('неведомая')) return ALERT_KIND.UNKNOWN;
    return null;
}

function alertMentionKey(username, kind) {
    return `${username}:${kind}`;
}

function shouldAppendMention(username, kind) {
    if (!username || !kind) return false;
    const until = alertMentionCooldownUntil.get(alertMentionKey(username, kind)) || 0;
    return Date.now() >= until;
}

function recordMention(username, kind) {
    if (!username || !kind) return;
    alertMentionCooldownUntil.set(
        alertMentionKey(username, kind),
        Date.now() + ALERT_MENTION_COOLDOWN_MS,
    );
}

/** Текст алерта + @sasha_pshonko (не чаще раза в час на бота и тип). */
export function buildTelegramAlertText({ message, botUsername, bots }) {
    let text = botUsername ? formatBotAlert(botUsername, message, bots) : String(message ?? '');
    const kind = botUsername ? classifyWorkerAlert(message) : null;
    if (kind && shouldAppendMention(botUsername, kind)) {
        recordMention(botUsername, kind);
        text = `${text} @${ALERT_MENTION_HANDLE}`;
    }
    return text;
}

export function formatOrchestratorPing(stats, bots = null) {
    const { configured, active, workersRunning, banned, waiting } = stats;
    const label = (u) => (bots ? formatBotLabel(u, bots) : u);
    const ok = active === configured && banned.length === 0 && waiting.length === 0;
    let text = `${ok ? '✅' : '⚠️'} В игре: ${active}/${configured}`;
    const extras = [];
    if (workersRunning !== active) extras.push(`воркеров: ${workersRunning}`);
    if (waiting.length) extras.push(`ждут вход: ${waiting.map(label).join(', ')}`);
    if (extras.length) text += ` (${extras.join(', ')})`;
    if (banned.length) text += `\n🚫 Забанены: ${banned.map(label).join(', ')}`;
    return text;
}

export async function stopWorkerNoRestart(username, ctx) {
    const bot = ctx.bots?.get(username);
    if (bot) {
        bot.success = false;
        bot.isManualStop = true;
    }
    const pending = ctx.pendingRestarts?.get(username);
    if (pending) {
        clearTimeout(pending);
        ctx.pendingRestarts.delete(username);
    }
    const entry = ctx.workers.get(username);
    if (!entry) return;
    clearBotPresence(username, ctx.botItems, ctx.botInventory);
    await ctx.terminateWorkerEntry(entry);
    ctx.workers.delete(username);
    ctx.pushPresenceToGo?.();
}

export async function markBotBanned(username, ctx, reason = '') {
    const bot = ctx.bots.get(username);
    if (bot) {
        bot.banned = true;
        bot.success = false;
        bot.isManualStop = true;
        if (!bot.bannedAt) bot.bannedAt = new Date().toISOString();
        if (reason) bot.banReason = String(reason).slice(0, 500);
    }
    await stopWorkerNoRestart(username, ctx);
    const anarchy = bot?.anarchy != null ? ` [${bot.anarchy}]` : '';
    await ctx.sendAlert(`🚫 ${username}${anarchy} забанен`, username);
}

/** FunAuth game-verified: 5с на анке без «чтобы двигаться». */
export function requestFunauthVerified(username, anarchy, ctx) {
    if (!username) return false;
    const payload = { action: 'funauth_verified', nick: username, anarchy };
    if (typeof ctx.sendToGo === 'function') {
        const ok = ctx.sendToGo(payload);
        if (ok) {
            console.log(`[funauth] verified via WS → ${username} an${anarchy ?? '?'}`);
            return true;
        }
    }
    const base = process.env.GO_HTTP_URL
        || (process.env.LOCAL_MODE === '1' || process.env.LOCAL_MODE === 'true'
            ? 'http://127.0.0.1:8080'
            : 'http://212.8.229.76:8080');
    fetch(`${base}/api/funauth/verified`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick: username, anarchy }),
    }).catch((e) => console.warn(`[funauth] verified HTTP fail: ${e.message}`));
    console.log(`[funauth] verified via HTTP → ${username} an${anarchy ?? '?'}`);
    return true;
}

/** FunAuth bind через Go WS (или HTTP fallback). */
export function requestFunauthBind(username, ctx) {
    const bot = ctx.bots?.get(username);
    const password = bot?.password;
    const anarchy = bot?.anarchy ?? null;
    if (!username || !password) {
        console.warn(`[funauth] нет пароля для ${username}`);
        return false;
    }
    const payload = { action: 'funauth_bind', nick: username, password, anarchy };
    if (typeof ctx.sendToGo === 'function') {
        const ok = ctx.sendToGo(payload);
        if (ok) {
            console.log(`[funauth] queued via WS → ${username} an${anarchy ?? '?'}`);
            return true;
        }
    }
    const base = process.env.GO_HTTP_URL
        || (process.env.LOCAL_MODE === '1' || process.env.LOCAL_MODE === 'true'
            ? 'http://127.0.0.1:8080'
            : 'http://212.8.229.76:8080');
    fetch(`${base}/api/funauth/bind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick: username, password, anarchy }),
    }).catch((e) => console.warn(`[funauth] HTTP fail: ${e.message}`));
    console.log(`[funauth] queued via HTTP → ${username} an${anarchy ?? '?'}`);
    return true;
}

/** Только /2fa с TG-акка, к которому ник уже привязан. */
export function requestFunauthTwoFa(username, ctx) {
    if (!username) {
        console.warn('[funauth] 2fa: пустой nick');
        return false;
    }
    const bot = ctx.bots?.get(username);
    const anarchy = bot?.anarchy ?? null;
    const payload = { action: 'funauth_2fa', nick: username, anarchy };
    if (typeof ctx.sendToGo === 'function') {
        const ok = ctx.sendToGo(payload);
        if (ok) {
            console.log(`[funauth] 2fa queued via WS → ${username}`);
            return true;
        }
    }
    const base = process.env.GO_HTTP_URL
        || (process.env.LOCAL_MODE === '1' || process.env.LOCAL_MODE === 'true'
            ? 'http://127.0.0.1:8080'
            : 'http://212.8.229.76:8080');
    fetch(`${base}/api/funauth/2fa`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick: username, anarchy }),
    }).catch((e) => console.warn(`[funauth] 2fa HTTP fail: ${e.message}`));
    console.log(`[funauth] 2fa queued via HTTP → ${username} an${anarchy ?? '?'}`);
    return true;
}

/** После FunAuth: ok → поднять воркер; no_accounts → тоже поднять позже, чтобы снова поймать хуйню и ретрайнуть bind. */
export async function handleFunauthGoMessage(dataObj, ctx) {
    if (!dataObj || typeof dataObj !== 'object') return false;
    const action = dataObj.action;
    if (action !== 'funauth_result' && action !== 'funauth_no_accounts') return false;

    const nick = String(dataObj.nick || '').trim();
    if (!nick) return true;
    const bot = ctx.bots?.get(nick);
    if (!bot) return true;

    if (action === 'funauth_no_accounts' || dataObj.error === 'no_accounts' || dataObj.error === 'all_on_other_anarchies') {
        const errHint = dataObj.error === 'all_on_other_anarchies'
            ? ` (все TG на других анках${dataObj.anarchy ? ', нужен an' + dataObj.anarchy : ''})`
            : '';
        console.log(`[funauth] no_accounts${errHint} → ${nick}, рестарт через 45с`);
        await ctx.sendAlert?.(
            `🚨 FunAuth: нет TG для ${nick}${errHint} — воркер встанет через 45с`,
            nick,
        );
        setTimeout(() => {
            if (bot.isManualStop && !ctx.workers?.get(nick)) {
                bot.isManualStop = false;
                console.log(`[funauth] рестарт после no_accounts → ${nick}`);
                ctx.runWorker?.(bot);
            }
        }, 45_000);
        return true;
    }

    if (dataObj.ok) {
        console.log(`[funauth] ok → рестарт ${nick}`);
        bot.isManualStop = false;
        if (!ctx.workers?.get(nick)) {
            ctx.runWorker?.(bot);
        }
        return true;
    }

    // другой fail — воркер остаётся выключенным
    console.log(`[funauth] fail ${nick}: ${dataObj.error || '?'} — без авторестарта`);
    return true;
}

/** true — обработано, не слать как обычный лог */
export async function handleWorkerStatusMessage(message, username, ctx) {
    if (message?.name === 'clan_setup') {
        requestClanSetup({
            anarchy: message.anarchy,
            reason: message.reason || 'clan',
            username,
        }, ctx);
        return true;
    }
    if (message?.name === 'treasury_empty') {
        if (markBotPresenceInactive(username, ctx, 'treasury_empty')) {
            await ctx.sendAlert?.(
                `💸 ${username}: казна пуста — как бан для Go, слоты вне ценообразования`,
                username,
            );
        }
        return true;
    }
    if (message?.name === 'treasury_ok') {
        if (clearBotPresenceInactive(username, ctx, 'balance_ok')) {
            await ctx.sendAlert?.(
                `💰 ${username}: баланс в норме — снова активен для Go`,
                username,
            );
        }
        return true;
    }
    if (message?.name === 'funauth_bind') {
        requestFunauthBind(message.username || username, ctx);
        return true;
    }
    if (message?.name === 'funauth_2fa') {
        requestFunauthTwoFa(message.username || username, ctx);
        await stopWorkerNoRestart(username, ctx);
        return true;
    }
    if (message?.name === 'funauth_verified') {
        const bot = ctx.bots?.get(username);
        requestFunauthVerified(
            message.username || username,
            message.anarchy ?? bot?.anarchy ?? null,
            ctx,
        );
        return true;
    }
    if (message?.name === 'banned') {
        await markBotBanned(username, ctx);
        return true;
    }
    if (typeof message === 'string' && message.toLowerCase().includes('забанен')) {
        await markBotBanned(username, ctx);
        return true;
    }
    if (typeof message === 'string' && classifyWorkerAlert(message) === ALERT_KIND.UNKNOWN) {
        // bind один раз (Go сам не дублирует); воркер гасим до результата FunAuth
        requestFunauthBind(username, ctx);
        await ctx.sendAlert?.(message, username);
        await stopWorkerNoRestart(username, ctx);
        return true;
    }
    return false;
}

/** Сумма предметов только от живых ботов (мёртвые = 0 в отчёте) */
export function collectPresenceItemCounts(bots, workers, botItems, botInventory) {
    const itemsCount = new Map();
    const inventoryCount = new Map();

    for (const [username, itemsList] of botItems) {
        if (!isBotAliveForPresence(username, bots, workers)) continue;
        if (!Array.isArray(itemsList)) continue;
        for (const itemId of itemsList) {
            itemsCount.set(itemId, (itemsCount.get(itemId) || 0) + 1);
        }
    }

    for (const [username, itemsList] of botInventory) {
        if (!isBotAliveForPresence(username, bots, workers)) continue;
        if (!Array.isArray(itemsList)) continue;
        for (const itemId of itemsList) {
            inventoryCount.set(itemId, (inventoryCount.get(itemId) || 0) + 1);
        }
    }

    return {
        items: Object.fromEntries(itemsCount),
        inventory: Object.fromEntries(inventoryCount),
    };
}

export function applyPricesToBots({ catalog, prices, bots, workers, safePostMessage }) {
    const priceMap = prices && typeof prices === 'object' ? prices : {};
    const cat = Array.isArray(catalog) ? catalog : [];

    const catalogAll = mergeCatalogWithPrices(cat, priceMap);
    let anyItems = false;
    for (const bot of bots.values()) {
        const goType = resolveGoType(bot);
        const botItems = itemPricesForBot(cat, priceMap, goType);
        bot.itemPrices = botItems;
        bot.catalogAll = catalogAll;
        if (botItems.length > 0) anyItems = true;
    }

    for (const [username] of workers) {
        const bot = bots.get(username);
        if (!bot) continue;
        safePostMessage(username, {
            type: 'price',
            data: bot.itemPrices || [],
            catalogAll,
        });
    }

    return { started: anyItems, anyItems };
}

/** Запуск воркеров после рестарта оркестратора /update, если Go уже прислал цены */
/** true — exit от устаревшего воркера (уже заменили terminate), не перезапускать */
export function shouldRestartWorkerOnExit(username, worker, workers) {
    const cur = workers.get(username);
    return cur?.worker === worker;
}

export function getWorkerRestartDelayMs(code, kickReason = '') {
    const s = String(kickReason);
    if (s.includes('ником уже онлайн') || s.includes('таким-же ником')) {
        return 45000;
    }
    return 5000;
}

export function terminateWorkerEntry(entry) {
    if (!entry?.worker) return Promise.resolve();
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    if (entry.restartTimerId) clearTimeout(entry.restartTimerId);

    const w = entry.worker;
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, 8000);
        const done = () => {
            clearTimeout(timer);
            resolve();
        };
        w.once('exit', done);
        try {
            w.terminate();
        } catch {
            done();
        }
    });
}

/** Агрегация мин. цен от воркеров; в Go только после полного окна windowMs */
export function createMarketFloorTracker({
    windowMs = MARKET_FLOOR_WINDOW_MS,
    checkMs = MARKET_FLOOR_CHECK_MS,
    onFlush,
}) {
    const agg = new Map();
    let timer = null;
    let gotDataThisWindow = false;
    let windowStartMs = null;
    let windowEndMs = null;

    const resetWindow = () => {
        agg.clear();
        gotDataThisWindow = false;
        windowStartMs = null;
        windowEndMs = null;
    };

    const mergeFloors = (floors) => {
        if (!floors || typeof floors !== 'object') return false;
        let merged = false;
        for (const [id, price] of Object.entries(floors)) {
            const p = Number(price);
            if (!p || p <= 0) continue;
            merged = true;
            const prev = agg.get(id);
            if (prev === undefined || p < prev) agg.set(id, p);
        }
        return merged;
    };

    return {
        mergeFromWorker(payload) {
            const floors = payload?.floors ?? payload;
            const ws = Number(payload?.window_start_ms);
            const we = Number(payload?.window_end_ms);
            if (!mergeFloors(floors)) return;
            gotDataThisWindow = true;
            if (Number.isFinite(ws) && ws > 0) {
                windowStartMs = windowStartMs === null ? ws : Math.min(windowStartMs, ws);
            }
            if (Number.isFinite(we) && we > 0) {
                windowEndMs = windowEndMs === null ? we : Math.max(windowEndMs, we);
            }
        },
        start() {
            if (timer) return;
            timer = setInterval(() => {
                if (!gotDataThisWindow || agg.size === 0 || windowStartMs === null || windowEndMs === null) {
                    resetWindow();
                    return;
                }
                const span = windowEndMs - windowStartMs;
                if (span < windowMs - MARKET_FLOOR_WINDOW_SLACK_MS) {
                    return;
                }
                onFlush(Object.fromEntries(agg), {
                    window_start_ms: windowStartMs,
                    window_end_ms: windowEndMs,
                });
                resetWindow();
            }, checkMs);
        },
    };
}

export async function tryAutoStartBots({
    reason,
    workers,
    isShuttingDown,
    catalog,
    prices,
    bots,
    safePostMessage,
    startBots,
    requestInfo,
    isPending,
    setPending,
    isStartBotsRunning,
}) {
    if (isShuttingDown) return;
    if (workers.size > 0) return;
    if (isPending()) return;
    if (isStartBotsRunning?.()) return;

    const { anyItems } = applyPricesToBots({
        catalog,
        prices,
        bots,
        workers,
        safePostMessage,
    });

    // Go выключен / ещё нет цен — всё равно стартуем с пустым списком товаров
    if (!catalog?.length || !anyItems) {
        console.log(
            `🚀 запуск ботов (${reason}): каталог пуст / нет цен Go — список товаров пустой`,
        );
    } else {
        console.log(`🚀 запуск ботов (${reason})`);
    }

    setPending(true);
    try {
        await startBots();
    } finally {
        setPending(false);
    }
}

export function applyWorkerBuyingClaim(itemsBuying, message, workerUsername) {
    let claim;
    if (typeof message.data === 'string') {
        claim = { uuid: message.data, username: workerUsername };
    } else if (message.data && typeof message.data === 'object') {
        claim = {
            uuid: message.data.uuid ?? message.data,
            username: message.data.username ?? workerUsername,
        };
    } else {
        return Array.isArray(itemsBuying) ? itemsBuying : [];
    }
    return mergeBuyingClaim(itemsBuying, claim);
}

export function buyingUuidForGo(message) {
    return uuidForGoBroadcast(message.data);
}

export function applyGoJsonUpdate(itemsBuying, goData) {
    return mergeGoJsonUpdate(itemsBuying, goData);
}

export { createListingStore } from './items/listing-store.mjs';
export { createWarpCoordinator } from './lib/warp-coord.mjs';

/** Запрос варпа от воркера → ответ с наименее занятым. */
export function handleWorkerWarpPick(warpCoord, message, username, safePostMessage) {
    if (message?.name !== 'warp_pick') return false;
    const warp = warpCoord.handlePick({
        username,
        anarchy: message.anarchy,
        lastWarp: message.lastWarp ?? null,
    });
    safePostMessage(username, {
        type: 'warp_pick_res',
        reqId: message.reqId,
        warp,
    });
    return true;
}

/** Сколько ждать success от воркера после старта */
export const WORKER_READY_TIMEOUT_MS = 120_000;

export function isWorkerReady(bots, username) {
    return !!bots.get(username)?.success;
}

/** Воркер вошёл на анархию — снимаем startup-таймаут */
export function ackWorkerReady(bots, workers, username) {
    const bot = bots.get(username);
    if (!bot) return false;
    bot.success = true;
    // presenceInactive снимается только когда баланс снова ≥ saveSum/2 (treasury_ok)
    const w = workers.get(username);
    if (w?.timeoutId) {
        clearTimeout(w.timeoutId);
        w.timeoutId = null;
    }
    return true;
}

/** git pull без локальных правок в tracked-файлах (xray.local.env перезаписывается из vless.url). */
export async function gitPullOriginMain(repoDir, branch = 'main') {
    await execFileAsync('git', ['fetch', 'origin'], { cwd: repoDir });
    await execFileAsync('git', ['reset', '--hard', `origin/${branch}`], { cwd: repoDir });
    const { stdout } = await execFileAsync('git', ['log', '-1', '--oneline'], { cwd: repoDir });
    return stdout.trim();
}

/** /update: git + vless.url → xray + проверка Telegram API */
export async function runOrchestratorUpdate(repoDir, branch = 'main') {
    const head = await gitPullOriginMain(repoDir, branch);
    const { syncVlessFromRepo, ensureTelegramProxy } = await import('./telegram-proxy.mjs');
    await syncVlessFromRepo();
    const proxyOk = await ensureTelegramProxy();
    return { head, proxyOk };
}
