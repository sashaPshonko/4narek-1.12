/**
 * Anti-AFK только WASD (как до «осмотра»): бурст ходьбы несколько секунд.
 * Голову не крутим — FunAC 4.3 цепляет look-пакеты.
 * Протокол 1.21 как ваниль: полный player_input при смене клавиш;
 * position/look → потом tick_end; hasHorizontalCollision из prismarine;
 * sprint не используем. Единый patch для 4narek-old / 4NAREK / roles.
 * Ямы: wasd-pit-guard + тормоз инерции; у края бурст не стартуем.
 */

import {
    awaitSettledOnFloor,
    clearWasd,
    isNearPitEdge,
    isStandingOnFloor,
    keyWouldFall,
    nextSafeWasdKey,
} from './wasd-pit-guard.mjs';

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
 * Бурст WASD ~3.5–5с: безопасные клавиши (не в яму), удержание ~0.7–1.2с.
 */
export async function antiAFKMove(bot, log = console.log, shouldAbort = null) {
    if (!bot?.entity || !bot.setControlState) return;
    const logFn = typeof log === 'function' ? log : console.log;
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    await closeWindowIfOpen(bot);
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    if (!isStandingOnFloor(bot)) {
        logFn('anti-AFK → стоп, нет пола под ногами (яма/полёт)');
        return;
    }
    if (isNearPitEdge(bot)) {
        logFn('anti-AFK → стоп, у края ямы (не жмём WASD)');
        await awaitSettledOnFloor(bot, { shouldAbort });
        return;
    }

    const burstMs = rndInt(MOVE_BURST_MS_MIN, MOVE_BURST_MS_MAX);
    const endAt = Date.now() + burstMs;
    logFn(`anti-AFK ходьба ~${(burstMs / 1000).toFixed(1)}с (бурст WASD)`);
    const st = { keyIndex: rndInt(0, WASD_KEYS.length - 1) };
    let pitSkips = 0;

    try {
        while (Date.now() < endAt) {
            if (typeof shouldAbort === 'function' && shouldAbort()) break;
            if (!isStandingOnFloor(bot)) {
                logFn('anti-AFK → стоп mid-burst, пол пропал');
                clearWasd(bot);
                break;
            }
            if (isNearPitEdge(bot)) {
                pitSkips++;
                logFn('anti-AFK → у края, стоп бурста');
                await awaitSettledOnFloor(bot, { shouldAbort });
                break;
            }

            const key = nextSafeWasdKey(bot, st, WASD_KEYS);
            if (!key) {
                pitSkips++;
                logFn('anti-AFK → все направления в яму, стоп');
                await awaitSettledOnFloor(bot, { shouldAbort });
                break;
            }
            const holdMs = rndInt(MOVE_KEY_HOLD_MS_MIN, MOVE_KEY_HOLD_MS_MAX);
            logFn(`anti-AFK клавиша ${key.toUpperCase()} ${holdMs}мс`);

            let hitEdge = false;
            try {
                bot.setControlState(key, true);
                const holdUntil = Date.now() + holdMs;
                while (Date.now() < holdUntil) {
                    if (typeof shouldAbort === 'function' && shouldAbort()) break;
                    if (Date.now() >= endAt) break;
                    if (keyWouldFall(bot, key) || !isStandingOnFloor(bot) || isNearPitEdge(bot)) {
                        pitSkips++;
                        hitEdge = true;
                        logFn(`anti-AFK → край/яма на ${key}, отпускаю`);
                        break;
                    }
                    await sleep(Math.min(40, holdUntil - Date.now()));
                }
            } finally {
                try {
                    bot.setControlState(key, false);
                } catch {
                    /* ignore */
                }
            }

            if (hitEdge) {
                await awaitSettledOnFloor(bot, { shouldAbort });
                if (!isStandingOnFloor(bot) || isNearPitEdge(bot)) {
                    logFn('anti-AFK → после тормоза всё ещё край/полёт, стоп');
                    break;
                }
            }

            if (typeof shouldAbort === 'function' && shouldAbort()) break;
            if (Date.now() >= endAt) break;
            await sleep(rndInt(MOVE_KEY_PAUSE_MS_MIN, MOVE_KEY_PAUSE_MS_MAX));
        }
    } finally {
        clearWasd(bot);
    }
    if (pitSkips) logFn(`anti-AFK → pit-guard срабатываний: ${pitSkips}`);
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

/** mineflayer control → protocol 1.21 Input flags (полный набор, как ваниль). */
const CONTROL_TO_INPUT = {
    forward: 'forward',
    back: 'backward',
    left: 'left',
    right: 'right',
    jump: 'jump',
    sneak: 'shift',
    sprint: 'sprint',
};

const INPUT_FLAG_TO_CONTROL = {
    forward: 'forward',
    backward: 'back',
    left: 'left',
    right: 'right',
    jump: 'jump',
    shift: 'sneak',
    sprint: 'sprint',
};

const MOVE_PACKET_NAMES = new Set(['position', 'look', 'position_look', 'flying']);

/** Sprint entity_action ids (string mapper + legacy). */
function isSprintStartAction(params) {
    const aid = params?.actionId;
    return aid === 'start_sprinting' || aid === 3;
}

/**
 * 1.21 как ваниль (единый patch для всех entrypoints):
 * - player_input только при смене, всегда полный bitset (7 флагов)
 * - sprint не используем: ignore true + глотаем start_sprinting
 * - глотаем урезанный {shift} из mineflayer physics
 * - по умолчанию НЕ трогаем position/look (fround+collision ломали Y→70 и /ah)
 * - tick_end после нашего player_input (чтобы FunTime видел ходьбу / снимал AFK)
 *
 * @param {import('mineflayer').Bot} bot
 * @param {{ rewriteMovePackets?: boolean }} [opts]
 *   rewriteMovePackets: true — старый полный режим (fround pos + tick_end на каждый move).
 *   Сейчас в проде false: иначе экономика FunTime мёртвая.
 */
export function patchWalking(bot, opts = {}) {
    if (!bot || bot._vanillaMovePatched) return;
    bot._vanillaMovePatched = true;
    bot._walk121Patched = true;

    const rewriteMovePackets = opts.rewriteMovePackets === true;

    if (typeof bot.setControlState === 'function' && bot._client) {
        applyWalkPatch(bot, { rewriteMovePackets });
    } else {
        bot.once('inject_allowed', () => setTimeout(
            () => applyWalkPatch(bot, { rewriteMovePackets }),
            0,
        ));
    }
}

/** Alias: старые импорты walk-121. */
export const patchWalking121 = patchWalking;

function fullInputsFrom(controlState) {
    const inputs = {};
    for (const [control, flag] of Object.entries(CONTROL_TO_INPUT)) {
        // sprint всегда false — не шлём в input
        inputs[flag] = control === 'sprint' ? false : !!controlState[control];
    }
    return inputs;
}

function applyWalkPatch(bot, { rewriteMovePackets = false } = {}) {
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
    bot._walk121Controls = controlState;
    const origSetControlState = bot.setControlState.bind(bot);
    const client = bot._client;
    if (!client || typeof client.write !== 'function') return;

    const rawWrite = client.write.bind(client);
    let suppressPlayerInput = false;
    let tickEndQueued = false;

    const queueTickEnd = () => {
        if (tickEndQueued) return;
        tickEndQueued = true;
        queueMicrotask(() => {
            tickEndQueued = false;
            if (client.state !== 'play') return;
            try {
                rawWrite('tick_end', {});
            } catch {
                /* ignore */
            }
        });
    };

    const writeInputs = () => {
        if (client.state !== 'play') return;
        try {
            rawWrite('player_input', { inputs: fullInputsFrom(controlState) });
            // без rewrite move-пакетов tick_end иначе не уходит — AFK не сходит
            queueTickEnd();
        } catch {
            /* ignore */
        }
    };

    const fixMoveFlags = (params) => {
        if (!params || typeof params !== 'object') return params;
        const onGround = !!(params.onGround ?? params.flags?.onGround);
        const horiz = !!(bot.entity?.isCollidedHorizontally);
        params.onGround = onGround;
        params.flags = { onGround, hasHorizontalCollision: horiz };
        if (Number.isFinite(params.x)) params.x = Math.fround(params.x);
        if (Number.isFinite(params.y)) params.y = Math.fround(params.y);
        if (Number.isFinite(params.z)) params.z = Math.fround(params.z);
        if (Number.isFinite(params.yaw)) params.yaw = Math.fround(params.yaw);
        if (Number.isFinite(params.pitch)) params.pitch = Math.fround(params.pitch);
        return params;
    };

    client.write = (name, params) => {
        if (name === 'entity_action' && isSprintStartAction(params)) {
            return;
        }
        if (name === 'player_input') {
            if (suppressPlayerInput) return;
            if (client.state !== 'play') return;
            const partial = params?.inputs;
            if (partial && typeof partial === 'object') {
                for (const [flag, control] of Object.entries(INPUT_FLAG_TO_CONTROL)) {
                    if (!Object.prototype.hasOwnProperty.call(partial, flag)) continue;
                    if (control === 'sprint') {
                        controlState.sprint = false;
                        continue;
                    }
                    controlState[control] = !!partial[flag];
                }
            }
            const out = rawWrite('player_input', { inputs: fullInputsFrom(controlState) });
            queueTickEnd();
            return out;
        }
        if (rewriteMovePackets && MOVE_PACKET_NAMES.has(name)) {
            const out = rawWrite(name, fixMoveFlags(params));
            queueTickEnd();
            return out;
        }
        return rawWrite(name, params);
    };

    bot.setControlState = function setControlStateVanilla(control, state) {
        if (!(control in controlState) || typeof state !== 'boolean') {
            return origSetControlState(control, state);
        }
        if (control === 'sprint') {
            if (state) return;
            if (!controlState.sprint) return;
            controlState.sprint = false;
            suppressPlayerInput = true;
            try {
                origSetControlState('sprint', false);
            } finally {
                suppressPlayerInput = false;
            }
            writeInputs();
            return;
        }
        if (controlState[control] === state) return;
        controlState[control] = state;

        suppressPlayerInput = true;
        let result;
        try {
            result = origSetControlState(control, state);
        } finally {
            suppressPlayerInput = false;
        }
        writeInputs();
        return result;
    };

    bot.refreshPlayerInput = writeInputs;
    bot._vanillaMoveRewritePos = rewriteMovePackets;
}
