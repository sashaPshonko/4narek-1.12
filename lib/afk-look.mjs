/** Осмотр и сход с AFK — рандомные направления/скорость, шаг GCD как у vanilla. */

/** Шаг мыши vanilla 100% — GCD как в mineflayer bot.look (плавные look-пакеты). */
const LOOK_GCD_STEP = 0.15 * (Math.PI / 180);
/** Пауза руки между сегментами (человек отпустил мышь). */
const LOOK_SEGMENT_PAUSE_MIN_MS = 40;
const LOOK_SEGMENT_PAUSE_MAX_MS = 180;

/** Разные «характеры» осмотра — не один и тот же 3–4 с. */
const LOOK_DURATION_MODES = [
    { weight: 22, min: 1200, max: 2200 }, // короткий взгляд
    { weight: 40, min: 2500, max: 4000 }, // обычный
    { weight: 28, min: 4000, max: 6000 }, // подольше
    { weight: 10, min: 6000, max: 8500 }, // редкий долгий
];

function pickLookDurationMs() {
    const total = LOOK_DURATION_MODES.reduce((s, m) => s + m.weight, 0);
    let r = Math.random() * total;
    for (const mode of LOOK_DURATION_MODES) {
        r -= mode.weight;
        if (r <= 0) return rndInt(mode.min, mode.max);
    }
    const last = LOOK_DURATION_MODES[LOOK_DURATION_MODES.length - 1];
    return rndInt(last.min, last.max);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function rndInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function clampPitch(pitch, maxPitch) {
    return Math.max(-maxPitch, Math.min(maxPitch, pitch));
}

/**
 * Один сегмент осмотра: своё направление и «скорость» (размер yaw-шага в GCD).
 * Иногда разворот внутри сегмента, чаще дёрганье pitch.
 */
async function lookSegment(bot, { turnDir, steps, yawUnitsMin, yawUnitsMax, maxPitch, shouldAbort, deadline }) {
    let dir = turnDir;
    let done = 0;
    /** После скольки шагов развернуть основной ход сегмента (не одна линия). */
    const reverseAt =
        steps >= 10 && Math.random() < 0.55 ? rndInt(Math.floor(steps * 0.25), Math.floor(steps * 0.7)) : -1;
    let microBack = 0;

    for (let i = 0; i < steps; i++) {
        if (Date.now() >= deadline) break;
        if (typeof shouldAbort === 'function' && shouldAbort()) break;
        if (!bot?.entity) break;

        if (i === reverseAt) dir = -dir;

        if (microBack > 0) {
            microBack--;
            if (microBack === 0) dir = -dir; // вернуть после 1–2 шагов назад
        } else if (Math.random() < 0.07) {
            dir = -dir;
            microBack = rndInt(1, 2);
        }

        const yawUnits = rndInt(yawUnitsMin, yawUnitsMax);
        const yaw = bot.entity.yaw + dir * yawUnits * LOOK_GCD_STEP;

        let pitch = bot.entity.pitch;
        if (Math.random() < 0.28) {
            const pitchUnits = rndInt(1, 4);
            pitch += (Math.random() < 0.5 ? -1 : 1) * pitchUnits * LOOK_GCD_STEP;
            pitch = clampPitch(pitch, maxPitch);
        }

        await bot.look(yaw, pitch, false);
        done++;
    }
    return done;
}

/**
 * Осмотр: несколько сегментов с разными dir/скоростью и разной длительностью.
 * Частота пакетов — через bot.look(..., false) и GCD-шаг (как vanilla).
 *
 * @param {import('mineflayer').Bot} bot
 * @param {(msg: string) => void} [log]
 * @param {(() => boolean) | null} [shouldAbort]
 */
export async function lookAroundSpin(bot, log = console.log, shouldAbort = null) {
    if (!bot?.entity) return;

    // совместимость: lookAroundSpin(bot, { log, shouldAbort })
    if (log && typeof log === 'object' && !Array.isArray(log)) {
        shouldAbort = log.shouldAbort ?? null;
        log = log.log ?? console.log;
    }

    const startedAt = Date.now();
    const startYaw = bot.entity.yaw;
    const startPitch = bot.entity.pitch;
    const maxPitch = (Math.PI / 2) * 0.22;
    const timeoutMs = pickLookDurationMs();
    const deadline = startedAt + timeoutMs;
    let doneSteps = 0;
    let segments = 0;

    while (Date.now() < deadline) {
        if (typeof shouldAbort === 'function' && shouldAbort()) break;
        if (!bot?.entity) break;

        const turnDir = Math.random() < 0.5 ? -1 : 1;
        // скорость сегмента: медленный / обычный / быстрый рывок
        const pace = Math.random();
        let yawUnitsMin;
        let yawUnitsMax;
        let steps;
        if (pace < 0.25) {
            yawUnitsMin = 1;
            yawUnitsMax = 3;
            steps = rndInt(10, 22);
        } else if (pace < 0.75) {
            yawUnitsMin = 2;
            yawUnitsMax = 6;
            steps = rndInt(8, 18);
        } else {
            yawUnitsMin = 4;
            yawUnitsMax = 9;
            steps = rndInt(5, 12);
        }

        const n = await lookSegment(bot, {
            turnDir,
            steps,
            yawUnitsMin,
            yawUnitsMax,
            maxPitch,
            shouldAbort,
            deadline,
        });
        doneSteps += n;
        segments++;

        if (Date.now() >= deadline) break;
        if (typeof shouldAbort === 'function' && shouldAbort()) break;

        // пауза между сегментами — не слать look (рука остановилась)
        if (Math.random() < 0.85) {
            await sleep(rndInt(LOOK_SEGMENT_PAUSE_MIN_MS, LOOK_SEGMENT_PAUSE_MAX_MS));
        }
    }

    const elapsedSec = (Date.now() - startedAt) / 1000;
    const yawDeg = Math.abs(bot.entity.yaw - startYaw) * (180 / Math.PI);
    const pitchDeg = Math.abs(bot.entity.pitch - startPitch) * (180 / Math.PI);
    const logFn = typeof log === 'function' ? log : console.log;
    logFn(
        `ОСМОТР ${doneSteps} шаг. / ${segments} сегм. за ${elapsedSec.toFixed(1)}с` +
            ` (лимит ${(timeoutMs / 1000).toFixed(1)}с)` +
            ` Δyaw~${yawDeg.toFixed(0)}° pitch ±${pitchDeg.toFixed(1)}°`,
    );
}

const WASD_KEYS = ['forward', 'back', 'left', 'right'];

function releaseWasd(bot) {
    if (!bot?.setControlState) return;
    for (const key of WASD_KEYS) {
        try {
            bot.setControlState(key, false);
        } catch {
            /* ignore */
        }
    }
}

/**
 * Коротко-зажатия WASD (без jump/sprint/sneak), 1–3 нажатия, разные hold/паузы.
 * @param {import('mineflayer').Bot} bot
 * @param {(msg: string) => void} [log]
 * @param {(() => boolean) | null} [shouldAbort]
 */
export async function wasdAntiAfkBurst(bot, log = console.log, shouldAbort = null) {
    if (!bot?.entity || !bot.setControlState) return;

    if (log && typeof log === 'object' && !Array.isArray(log)) {
        shouldAbort = log.shouldAbort ?? null;
        log = log.log ?? console.log;
    }
    const logFn = typeof log === 'function' ? log : console.log;

    const presses = rndInt(1, 3);
    const parts = [];

    try {
        for (let i = 0; i < presses; i++) {
            if (typeof shouldAbort === 'function' && shouldAbort()) break;

            await sleep(rndInt(70, 280));

            const primary = WASD_KEYS[rndInt(0, WASD_KEYS.length - 1)];
            /** Иногда диагональ (две оси), без противоположных. */
            let secondary = null;
            if (Math.random() < 0.28) {
                const ortho =
                    primary === 'forward' || primary === 'back'
                        ? ['left', 'right']
                        : ['forward', 'back'];
                secondary = ortho[rndInt(0, 1)];
            }

            const holdMs = rndInt(160, 580);
            bot.setControlState(primary, true);
            if (secondary) bot.setControlState(secondary, true);
            parts.push(secondary ? `${primary}+${secondary}/${holdMs}` : `${primary}/${holdMs}`);

            const holdUntil = Date.now() + holdMs;
            while (Date.now() < holdUntil) {
                if (typeof shouldAbort === 'function' && shouldAbort()) break;
                await sleep(Math.min(40, holdUntil - Date.now()));
            }

            bot.setControlState(primary, false);
            if (secondary) bot.setControlState(secondary, false);

            if (i < presses - 1) {
                await sleep(rndInt(120, 900));
            }
        }
    } finally {
        releaseWasd(bot);
    }

    logFn(`WASD anti-AFK ×${presses}: ${parts.join(', ') || 'abort'}`);
}

/**
 * Случайный сценарий схода с AFK: look / wasd / комбинации.
 * @returns {'look' | 'wasd' | 'look_wasd' | 'wasd_look'}
 */
export function pickAntiAfkPlan() {
    const r = Math.random();
    if (r < 0.34) return 'look';
    if (r < 0.52) return 'wasd';
    if (r < 0.78) return 'look_wasd';
    return 'wasd_look';
}

/**
 * Полный anti-AFK motion (мышь и/или WASD).
 */
export async function runAntiAfkMotion(bot, log = console.log, shouldAbort = null) {
    if (log && typeof log === 'object' && !Array.isArray(log)) {
        shouldAbort = log.shouldAbort ?? null;
        log = log.log ?? console.log;
    }
    const logFn = typeof log === 'function' ? log : console.log;
    const plan = pickAntiAfkPlan();
    logFn(`anti-AFK план → ${plan}`);

    if (plan === 'look') {
        await lookAroundSpin(bot, logFn, shouldAbort);
        return;
    }
    if (plan === 'wasd') {
        await wasdAntiAfkBurst(bot, logFn, shouldAbort);
        return;
    }
    if (plan === 'look_wasd') {
        await lookAroundSpin(bot, logFn, shouldAbort);
        if (typeof shouldAbort === 'function' && shouldAbort()) return;
        await sleep(rndInt(180, 650));
        await wasdAntiAfkBurst(bot, logFn, shouldAbort);
        return;
    }
    await wasdAntiAfkBurst(bot, logFn, shouldAbort);
    if (typeof shouldAbort === 'function' && shouldAbort()) return;
    await sleep(rndInt(180, 650));
    await lookAroundSpin(bot, logFn, shouldAbort);
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ afk: boolean }} state
 * @param {(msg: string) => void} [log]
 * @param {(() => boolean) | null} [shouldAbort]
 * @param {(() => Promise<void>) | null} [closeWindow]
 */
export async function antiAfkIfNeeded(bot, state, log = console.log, shouldAbort = null, closeWindow = null) {
    // antiAfkIfNeeded(bot, state, { log, shouldAbort, closeWindow })
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
    } else if (bot.currentWindow) {
        await sleep(400 + Math.floor(Math.random() * 400));
        try {
            await bot.closeWindow(bot.currentWindow);
        } catch {
            /* ignore */
        }
    }

    await runAntiAfkMotion(bot, logFn, shouldAbort);
    state.afk = false;
    logFn('AFK снят');
}
