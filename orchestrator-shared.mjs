/**
 * Общая логика оркестраторов: каталог с Go, активные типы, цены.
 *
 * Старая/новая броня в одном items_config.json:
 * — старые предметы: type "netherite_chestplate-1.21"
 * — новые предметы: другой type, напр. "netherite_chestplate-new-1.21"
 * — в bots.json у новых трёх ботов: goType "netherite_chestplate-new-1.21"
 * — у старых ботов остаётся goType "netherite_chestplate-1.21"
 * Бот в getBestAHSlot покупает только catalog.type === bot.goType.
 */

/** AH search в боте (human) → go type для сервера */
export const ITEM_TO_GO_TYPE = {
    'netherite sword': 'netherite_sword-1.21',
    'netherite leggings': 'netherite_leggings-1.21',
    'netherite chestplate': 'netherite_chestplate-1.21',
    'netherite helmet': 'netherite_helmet-1.21',
    'netherite boots': 'netherite_boots-1.21',
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
    return mergeCatalogWithPrices(catalog, prices).filter((item) => item.type === goType);
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

export function buildPresencePayload(bots, workers, botItems, botInventory) {
    const presence = collectPresenceItemCounts(bots, workers, botItems, botInventory);
    return {
        action: 'presence',
        items: presence.items,
        inventory: presence.inventory,
        active_types: collectActiveTypes(bots, workers),
    };
}

export function collectActiveTypes(bots, workers) {
    const types = new Set();
    for (const [username, workerData] of workers) {
        if (!workerData?.worker || workerData.worker.terminated) continue;
        const bot = bots.get(username);
        if (!bot?.success) continue;
        const goType = resolveGoType(bot);
        if (goType) types.add(goType);
    }
    return [...types];
}

/** Бот считается «живым» для presence и active_types */
export function isBotAliveForPresence(username, bots, workers) {
    const workerData = workers.get(username);
    const bot = bots.get(username);
    return !!(workerData?.worker && !workerData.worker.terminated && bot?.success);
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

export function formatOrchestratorPing(stats) {
    const { configured, active, workersRunning, banned, waiting } = stats;
    const ok = active === configured && banned.length === 0 && waiting.length === 0;
    let text = `${ok ? '✅' : '⚠️'} В игре: ${active}/${configured}`;
    const extras = [];
    if (workersRunning !== active) extras.push(`воркеров: ${workersRunning}`);
    if (waiting.length) extras.push(`ждут вход: ${waiting.join(', ')}`);
    if (extras.length) text += ` (${extras.join(', ')})`;
    if (banned.length) text += `\n🚫 Забанены: ${banned.join(', ')}`;
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

export async function markBotBanned(username, ctx) {
    const bot = ctx.bots.get(username);
    if (bot) {
        bot.banned = true;
        bot.success = false;
        bot.isManualStop = true;
    }
    await stopWorkerNoRestart(username, ctx);
    await ctx.sendAlert(`🚫 ${username} забанен`);
}

/** true — обработано, не слать как обычный лог */
export async function handleWorkerStatusMessage(message, username, ctx) {
    if (message?.name === 'banned') {
        await markBotBanned(username, ctx);
        return true;
    }
    if (typeof message === 'string' && message.toLowerCase().includes('забанен')) {
        await markBotBanned(username, ctx);
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
    if (!prices) return { started: false, anyItems: false };

    let anyItems = false;
    for (const bot of bots.values()) {
        const goType = resolveGoType(bot);
        const botItems = itemPricesForBot(catalog, prices, goType);
        bot.itemPrices = botItems;
        if (botItems.length > 0) anyItems = true;
    }

    for (const [username] of workers) {
        const bot = bots.get(username);
        if (!bot) continue;
        safePostMessage(username, { type: 'price', data: bot.itemPrices || [] });
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
    if (code !== 0) {
        return 15000;
    }
    return 10000;
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

/** Агрегация мин. цен лотов с АХ от воркеров → Go раз в intervalMs (по умолчанию 10 мин) */
export function createMarketFloorTracker({ intervalMs = 10 * 60 * 1000, onFlush }) {
    const agg = new Map();
    let timer = null;
    let gotDataThisWindow = false;

    return {
        mergeFromWorker(floors) {
            if (!floors || typeof floors !== 'object') return;
            let merged = false;
            for (const [id, price] of Object.entries(floors)) {
                const p = Number(price);
                if (!p || p <= 0) continue;
                merged = true;
                const prev = agg.get(id);
                if (prev === undefined || p < prev) agg.set(id, p);
            }
            if (merged) gotDataThisWindow = true;
        },
        start() {
            if (timer) return;
            timer = setInterval(() => {
                if (!gotDataThisWindow || agg.size === 0) {
                    agg.clear();
                    gotDataThisWindow = false;
                    return;
                }
                onFlush(Object.fromEntries(agg));
                agg.clear();
                gotDataThisWindow = false;
            }, intervalMs);
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

    if (!catalog?.length || !anyItems) {
        console.log(`⏳ автозапуск (${reason}): catalog=${catalog?.length ?? 0} anyItems=${anyItems}`);
        requestInfo?.();
        return;
    }

    setPending(true);
    try {
        console.log(`🚀 запуск ботов (${reason})`);
        await startBots();
    } finally {
        setPending(false);
    }
}
