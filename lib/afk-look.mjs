/**
 * Anti-AFK: только WASD, без поворота головы.
 * Частоту задаёт вызывающий код (walkGap / antiAfkIfNeeded).
 */

const WASD_KEYS = ['forward', 'left', 'back', 'right'];

/** @type {WeakMap<object, { keyIndex: number }>} */
const stateByBot = new WeakMap();

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function rnd(min, max) {
    return min + Math.random() * (max - min);
}

function getState(bot) {
    let s = stateByBot.get(bot);
    if (!s) {
        s = { keyIndex: 0 };
        stateByBot.set(bot, s);
    }
    return s;
}

async function closeWindowIfOpen(bot) {
    if (!bot?.currentWindow) return;
    try {
        await bot.closeWindow(bot.currentWindow);
    } catch {
        /* ignore */
    }
}

/** Голову не крутим. */
export async function antiAFKdragMouse(_bot, _log = console.log, _shouldAbort = null) {
    return;
}

/** Одна WASD-клавиша по кругу (без диагоналей). */
export async function antiAFKMove(bot, log = console.log, shouldAbort = null) {
    if (!bot?.entity || !bot.setControlState) return;
    if (log && typeof log === 'object' && !Array.isArray(log)) {
        shouldAbort = log.shouldAbort ?? null;
        log = log.log ?? console.log;
    }
    const logFn = typeof log === 'function' ? log : console.log;
    const st = getState(bot);

    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    await closeWindowIfOpen(bot);
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    const key = WASD_KEYS[st.keyIndex % WASD_KEYS.length];
    const duration = 250 + Math.random() * 250;
    logFn(`anti-AFK клавиша ${key.toUpperCase()} ${Math.round(duration)}мс`);

    await sleep(rnd(100, 300));
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    try {
        bot.setControlState(key, true);
        const holdUntil = Date.now() + duration;
        while (Date.now() < holdUntil) {
            if (typeof shouldAbort === 'function' && shouldAbort()) break;
            await sleep(Math.min(40, holdUntil - Date.now()));
        }
    } finally {
        try {
            bot.setControlState(key, false);
        } catch {
            /* ignore */
        }
    }

    await sleep(rnd(100, 300));
    st.keyIndex = (st.keyIndex + 1) % WASD_KEYS.length;
}

/**
 * Полный тик: только WASD. opts.force игнорируется.
 */
export async function runAntiAfkMotion(bot, log = console.log, shouldAbort = null, _opts = null) {
    if (log && typeof log === 'object' && !Array.isArray(log)) {
        shouldAbort = log.shouldAbort ?? null;
        log = log.log ?? console.log;
    }

    await antiAFKMove(bot, log, shouldAbort);
}

/** Совместимость: lookAroundSpin ≡ runAntiAfkMotion. */
export async function lookAroundSpin(bot, log = console.log, shouldAbort = null, opts = null) {
    return runAntiAfkMotion(bot, log, shouldAbort, opts);
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ afk: boolean }} state
 */
export async function antiAfkIfNeeded(bot, state, log = console.log, shouldAbort = null, closeWindow = null) {
    if (log && typeof log === 'object' && !Array.isArray(log)) {
        shouldAbort = log.shouldAbort ?? null;
        closeWindow = log.closeWindow ?? null;
        log = log.log ?? console.log;
    }

    if (!state.afk) return;
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    const logFn = typeof log === 'function' ? log : console.log;
    logFn('AFK → motion');

    if (typeof closeWindow === 'function') {
        await closeWindow();
    } else {
        await closeWindowIfOpen(bot);
    }

    await runAntiAfkMotion(bot, logFn, shouldAbort);
    state.afk = false;
    logFn('AFK снят');
}

/** Чат-маркер FunTime → AFK. */
export function noteAfkChat(text, state) {
    if (!text || !state) return false;
    if (text.includes('Данная команда недоступна в режиме AFK')) {
        state.afk = true;
        return true;
    }
    return false;
}

/** Следующий интервал walkTime: 50–60 с. */
export function nextWalkGapMs() {
    return 50_000 + Math.floor(Math.random() * 10_001);
}
