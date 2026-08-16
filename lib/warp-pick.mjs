/** Варпы для «прогулки» перед выставлением на АХ. */
export const WARP_NAMES = ['mine', 'casino', 'case', 'shop', 'portal', 'palach', 'fisher', 'stash'];

export const WARP_COOLDOWN_BASE_MS = 120_000;
export const WARP_COOLDOWN_JITTER_MS = 45_000;
export const WARP_SKIP_BPS = 1200; // ~12% — иногда не варпаемся в этом цикле

function hash32(str) {
    let h = 2166136261;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

/** Персональный кулдаун — боты не бьют /warp одновременно. */
export function warpCooldownMs(username) {
    return WARP_COOLDOWN_BASE_MS + (hash32(username) % WARP_COOLDOWN_JITTER_MS);
}

/** Задержка первого варпа после старта воркера (0–89 с). */
export function warpStartupDelayMs(username) {
    return (hash32(username) % 60) * 1000 + (hash32(`${username}:start`) % 30) * 1000;
}

/**
 * Можно ли в этот sellItems-цикл идти на варп.
 * @param {number} [lastWarpTime] — ms, 0 если ещё не варпались
 */
export function shouldAttemptWarp(username, lastWarpTime, workerStartTime, nowMs = Date.now()) {
    if (!lastWarpTime) {
        if (nowMs - workerStartTime < warpStartupDelayMs(username)) return false;
    } else if (nowMs - lastWarpTime < warpCooldownMs(username)) {
        return false;
    }

    if (lastWarpTime) {
        const minute = Math.floor(nowMs / 60_000);
        if (hash32(`${username}:skip:${minute}`) % 10_000 < WARP_SKIP_BPS) return false;
    }
    return true;
}

/** Детерминированный порядок варпов для пары username + anarchy. */
export function warpPreferenceOrder(username, anarchy) {
    let seed = hash32(`${username}:${anarchy}`);
    const arr = [...WARP_NAMES];
    const rnd = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 0x100000000;
    };
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/** Сдвигаем старт списка каждые ~2 ч — не застреваем на одном «любимом» варпе. */
export function rotatedWarpOrder(username, anarchy, nowMs = Date.now()) {
    const order = warpPreferenceOrder(username, anarchy);
    const bucket = Math.floor(nowMs / (2 * 60 * 60 * 1000));
    const offset = hash32(`${username}:${anarchy}:${bucket}`) % order.length;
    return [...order.slice(offset), ...order.slice(0, offset)];
}

/**
 * Выбор варпа: минимум соседей, не повторять lastWarp если есть альтернатива.
 * @param {Record<string, number>} occupancy — warp → число других ботов
 */
export function pickWarp({ username, anarchy, lastWarp = null, occupancy = {}, nowMs = Date.now() }) {
    const order = rotatedWarpOrder(username, anarchy, nowMs);
    const countAt = (w) => Number(occupancy[w] || 0);

    const withoutLast = lastWarp ? order.filter((w) => w !== lastWarp) : order;
    const pool = withoutLast.length ? withoutLast : order;

    let minCount = Infinity;
    for (const w of pool) minCount = Math.min(minCount, countAt(w));

    for (const w of pool) {
        if (countAt(w) === minCount) return w;
    }
    return order[0];
}
