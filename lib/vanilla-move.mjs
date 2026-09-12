/**
 * Anti-AFK только WASD (как до «осмотра»): бурст ходьбы несколько секунд.
 * Голову не крутим — FunAC 4.3 цепляет look-пакеты.
 * player_input только при смене клавиши, tick_end только с physicsTick.
 */
const WASD_KEYS = ['forward', 'left', 'back', 'right'];

/** Как TIMING.MOVE_BURST / MOVE_KEY_* до осмотра. */
const MOVE_BURST_MS_MIN = 3_500;
const MOVE_BURST_MS_MAX = 5_000;
const MOVE_KEY_HOLD_MS_MIN = 700;
const MOVE_KEY_HOLD_MS_MAX = 1_200;
const MOVE_KEY_PAUSE_MS_MIN = 80;
const MOVE_KEY_PAUSE_MS_MAX = 200;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function rndInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

async function closeWindowIfOpen(bot) {
    if (!bot?.currentWindow) return;
    try {
        await bot.closeWindow(bot.currentWindow);
    } catch {
        /* ignore */
    }
}

/** Голову не крутим. Оставлено no-op, чтобы старые вызовы не слали look. */
export async function antiAFKdragMouse(_bot, _log = console.log, _shouldAbort = null) {
    return;
}

/**
 * Бурст WASD ~3.5–5с: случайные клавиши, удержание ~0.7–1.2с (как до осмотра).
 * Не один тычок 160–420мс.
 */
export async function antiAFKMove(bot, log = console.log, shouldAbort = null) {
    if (!bot?.entity || !bot.setControlState) return;
    const logFn = typeof log === 'function' ? log : console.log;
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    await closeWindowIfOpen(bot);
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    const burstMs = rndInt(MOVE_BURST_MS_MIN, MOVE_BURST_MS_MAX);
    const endAt = Date.now() + burstMs;
    logFn(`anti-AFK ходьба ~${(burstMs / 1000).toFixed(1)}с (бурст WASD)`);

    try {
        while (Date.now() < endAt) {
            if (typeof shouldAbort === 'function' && shouldAbort()) break;

            const key = WASD_KEYS[rndInt(0, WASD_KEYS.length - 1)];
            const holdMs = rndInt(MOVE_KEY_HOLD_MS_MIN, MOVE_KEY_HOLD_MS_MAX);
            logFn(`anti-AFK клавиша ${key.toUpperCase()} ${holdMs}мс`);

            try {
                bot.setControlState(key, true);
                const holdUntil = Date.now() + holdMs;
                while (Date.now() < holdUntil) {
                    if (typeof shouldAbort === 'function' && shouldAbort()) break;
                    if (Date.now() >= endAt) break;
                    await sleep(Math.min(40, holdUntil - Date.now()));
                }
            } finally {
                try {
                    bot.setControlState(key, false);
                } catch {
                    /* ignore */
                }
            }

            if (typeof shouldAbort === 'function' && shouldAbort()) break;
            if (Date.now() >= endAt) break;
            await sleep(rndInt(MOVE_KEY_PAUSE_MS_MIN, MOVE_KEY_PAUSE_MS_MAX));
        }
    } finally {
        for (const key of WASD_KEYS) {
            try {
                bot.setControlState(key, false);
            } catch {
                /* ignore */
            }
        }
    }
}

export async function runAntiAfkMotion(bot, log = console.log, shouldAbort = null, _opts = null) {
    if (log && typeof log === 'object' && !Array.isArray(log)) {
        shouldAbort = log.shouldAbort ?? null;
        log = log.log ?? console.log;
    }
    await antiAFKMove(bot, log, shouldAbort);
}

export async function lookAroundSpin(bot, log = console.log, shouldAbort = null, opts = null) {
    return runAntiAfkMotion(bot, log, shouldAbort, opts);
}

export async function antiAfkIfNeeded(bot, state, log = console.log, shouldAbort = null, closeWindow = null) {
    if (log && typeof log === 'object' && !Array.isArray(log)) {
        shouldAbort = log.shouldAbort ?? null;
        closeWindow = log.closeWindow ?? null;
        log = log.log ?? console.log;
    }
    if (!state.afk) return;
    if (typeof shouldAbort === 'function' && shouldAbort()) return;
    const logFn = typeof log === 'function' ? log : console.log;
    logFn('AFK → ходьба');
    if (typeof closeWindow === 'function') await closeWindow();
    else await closeWindowIfOpen(bot);
    await runAntiAfkMotion(bot, logFn, shouldAbort);
    state.afk = false;
    logFn('AFK снят');
}

export function noteAfkChat(text, state) {
    if (!text || !state) return false;
    if (text.includes('Данная команда недоступна в режиме AFK')) {
        state.afk = true;
        return true;
    }
    return false;
}

export function nextWalkGapMs() {
    return 50_000 + Math.floor(Math.random() * 10_001);
}

const CONTROL_TO_INPUT = {
    forward: 'forward',
    back: 'backward',
    left: 'left',
    right: 'right',
    jump: 'jump',
    sneak: 'shift',
    sprint: 'sprint',
};

/**
 * 1.21: полный player_input при смене клавиши; tick_end только с physicsTick.
 * Без 50мс fallback и без refresh каждый тик.
 */
export function patchWalking(bot) {
    if (!bot || bot._vanillaMovePatched) return;
    bot._vanillaMovePatched = true;
    bot._walk121Patched = true;

    if (typeof bot.setControlState === 'function') {
        applyWalkPatch(bot);
    } else {
        bot.once('inject_allowed', () => setTimeout(() => applyWalkPatch(bot), 0));
    }
}

function applyWalkPatch(bot) {
    if (typeof bot.setControlState !== 'function') return;
    if (bot._vanillaMoveControls) return;

    const controlState = {
        forward: false,
        back: false,
        left: false,
        right: false,
        jump: false,
        sprint: false,
        sneak: false,
    };
    bot._vanillaMoveControls = controlState;
    const origSetControlState = bot.setControlState.bind(bot);

    const writeInputs = () => {
        if (bot._client?.state !== 'play') return;
        const inputs = {};
        for (const [control, flag] of Object.entries(CONTROL_TO_INPUT)) {
            inputs[flag] = controlState[control];
        }
        try {
            bot._client.write('player_input', { inputs });
        } catch {
            /* ignore */
        }
    };

    bot.setControlState = function setControlStateVanilla(control, state) {
        if (!(control in controlState) || typeof state !== 'boolean') {
            return origSetControlState(control, state);
        }
        if (controlState[control] === state) return;
        controlState[control] = state;
        const result = origSetControlState(control, state);
        writeInputs();
        return result;
    };

    /** Walk-route: повторный write без смены клавиши. */
    bot.refreshPlayerInput = writeInputs;

    const writeTickEnd = () => {
        if (bot._client?.state !== 'play') return;
        try {
            bot._client.write('tick_end', {});
        } catch {
            /* ignore */
        }
    };

    bot.on('physicsTick', writeTickEnd);
}
