/**
 * Anti-AFK как у рабочего клиента на FunTime:
 * один микроджиттер мыши + одна WASD-клавиша.
 * Частоту задаёт вызывающий код (walkGap / antiAfkIfNeeded), не внутренние кулдауны.
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

function normalizeAngle(angle) {
    while (angle > Math.PI) angle -= 2 * Math.PI;
    while (angle < -Math.PI) angle += 2 * Math.PI;
    return angle;
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

/** Один микроджиттер мыши. */
export async function antiAFKdragMouse(bot, log = console.log, shouldAbort = null) {
    if (!bot?.entity) return;
    if (log && typeof log === 'object' && !Array.isArray(log)) {
        shouldAbort = log.shouldAbort ?? null;
        log = log.log ?? console.log;
    }
    const logFn = typeof log === 'function' ? log : console.log;

    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    await closeWindowIfOpen(bot);
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    await sleep(rnd(50, 70));
    if (typeof shouldAbort === 'function' && shouldAbort()) return;
    if (!bot.entity) return;

    const currentYaw = bot.entity.yaw;
    const jitterYaw = (Math.random() * 2 - 1) * 0.2;
    let targetYaw = currentYaw + jitterYaw;
    targetYaw = currentYaw + normalizeAngle(targetYaw - currentYaw);
    const smoothing = 0.8;
    const smoothYaw = currentYaw * smoothing + targetYaw * (1 - smoothing);

    const currentPitch = bot.entity.pitch;
    const jitterPitch = (Math.random() * 2 - 1) * 0.1;
    const newPitch = currentPitch + jitterPitch;
    const targetPitch = Math.max(-0.5, Math.min(0.1, newPitch));
    const smoothPitch = -0.2 * 0.3 + targetPitch * 0.7;

    await bot.look(smoothYaw, smoothPitch, true);
    logFn(
        `anti-AFK мышь (${currentYaw.toFixed(2)}, ${currentPitch.toFixed(2)}) → (${smoothYaw.toFixed(2)}, ${smoothPitch.toFixed(2)})`,
    );

    await sleep(rnd(500, 1000));
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
 * Полный тик: мышь + ход. Всегда оба (вызов уже редкий снаружи).
 * opts.force — совместимость со старыми вызовами, игнорируется.
 */
export async function runAntiAfkMotion(bot, log = console.log, shouldAbort = null, _opts = null) {
    if (log && typeof log === 'object' && !Array.isArray(log)) {
        shouldAbort = log.shouldAbort ?? null;
        log = log.log ?? console.log;
    }

    await antiAFKdragMouse(bot, log, shouldAbort);
    if (typeof shouldAbort === 'function' && shouldAbort()) return;
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
