/**
 * Anti-AFK: WASD или один поворот «как запись пилота».
 * Jump / прогулки / warp внутри antiAFK — нет.
 *
 * Look (эталон motion-records + walk-route sendLook):
 * - цель одна (одиночный поворот)
 * - bot.look(yaw, pitch, true) — force=true, как пакет мыши клиента
 * - Δ только целыми шагами мыши 0.15° (GCD), иначе FunAC видит «кривую» мышь
 * - после look синхронизируем entity.yaw/pitch с тем, что ушло
 * - тик ~50мс, за тик ~3–12 юнитов (в записи p50≈5)
 */

const LOOK_GCD_STEP = 0.15 * (Math.PI / 180);
const YAW_DEADBAND = 0.04;
const TICK_MS = 50;
const WASD_KEYS = ['forward', 'left', 'back', 'right'];

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function rnd(min, max) {
    return min + Math.random() * (max - min);
}

function rndInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function normalizeAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}

function deltaYaw(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
}

function clampPitch(p) {
    return Math.max(-0.85, Math.min(0.55, p));
}

async function closeWindowIfOpen(bot) {
    if (!bot?.currentWindow) return;
    try {
        await bot.closeWindow(bot.currentWindow);
    } catch {
        /* ignore */
    }
}

function clearKeys(bot) {
    if (!bot?.setControlState) return;
    try {
        for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
            bot.setControlState(k, false);
        }
    } catch {
        /* ignore */
    }
}

/** Как walk-route sendLook: force=true + sync entity. */
async function sendLook(bot, yaw, pitch) {
    try {
        await bot.look(yaw, pitch, true);
        if (bot.entity) {
            bot.entity.yaw = yaw;
            bot.entity.pitch = pitch;
        }
    } catch {
        try {
            if (bot.entity) {
                bot.entity.yaw = yaw;
                bot.entity.pitch = pitch;
            }
        } catch {
            /* ignore */
        }
    }
}

/**
 * Один тик мыши к цели — только целые GCD-юниты (запись: ~3–12 / 50мс).
 * @returns {boolean} дошли до цели
 */
async function lookTickToward(bot, targetYaw, targetPitch) {
    if (!bot?.entity) return true;
    const curYaw = bot.entity.yaw;
    const curPitch = bot.entity.pitch;
    const dy = deltaYaw(targetYaw, curYaw);
    let nextYaw = curYaw;
    if (Math.abs(dy) > YAW_DEADBAND) {
        const units = Math.min(12, Math.max(1, Math.floor(Math.abs(dy) / LOOK_GCD_STEP)));
        // как в записи: не всегда max, чаще 3–10
        const step = Math.min(units, rndInt(3, 10));
        nextYaw = normalizeAngle(curYaw + Math.sign(dy) * step * LOOK_GCD_STEP);
    }
    let nextPitch = curPitch;
    const dp = targetPitch - curPitch;
    if (Math.abs(dp) > LOOK_GCD_STEP) {
        const pu = Math.min(4, Math.max(1, Math.floor(Math.abs(dp) / LOOK_GCD_STEP)));
        nextPitch = curPitch + Math.sign(dp) * pu * LOOK_GCD_STEP;
    }
    nextPitch = clampPitch(nextPitch);
    await sendLook(bot, nextYaw, nextPitch);
    return Math.abs(deltaYaw(targetYaw, nextYaw)) <= YAW_DEADBAND * 2
        && Math.abs(targetPitch - nextPitch) <= LOOK_GCD_STEP * 2;
}

/** Одна WASD 160–420мс — vanilla player_input через patch. */
async function wasdTap(bot, logFn, shouldAbort) {
    const key = WASD_KEYS[rndInt(0, WASD_KEYS.length - 1)];
    const duration = rndInt(160, 420);
    logFn(`anti-AFK → WASD ${key} ${duration}мс`);
    await sleep(rndInt(40, 120));
    if (typeof shouldAbort === 'function' && shouldAbort()) return 'abort';
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
    await sleep(rndInt(60, 180));
    return `wasd:${key}`;
}

/**
 * Одиночный поворот к одной цели — как мышь в записи пилота.
 */
async function lookSweep(bot, logFn, shouldAbort) {
    if (!bot?.entity || typeof bot.look !== 'function') return 'look:skip';
    const targetYaw = normalizeAngle(
        bot.entity.yaw + (Math.random() < 0.5 ? -1 : 1) * rnd(0.45, 1.25),
    );
    const targetPitch = clampPitch(bot.entity.pitch + rnd(-0.12, 0.08));
    const maxMs = rndInt(500, 1100);
    logFn(`anti-AFK → look (запись/GCD force=true) ~${(maxMs / 1000).toFixed(1)}с`);
    const until = Date.now() + maxMs;
    let ticks = 0;
    while (Date.now() < until) {
        if (typeof shouldAbort === 'function' && shouldAbort()) break;
        const done = await lookTickToward(bot, targetYaw, targetPitch);
        ticks++;
        if (done) break;
        await sleep(TICK_MS);
    }
    return `look:${ticks}`;
}

/**
 * @returns {Promise<{ ok: boolean, mode: string }>}
 */
export async function clientLikeUnAfk(bot, log = console.log, shouldAbort = null, opts = null) {
    const logFn = typeof log === 'function' ? log : console.log;
    const options = opts && typeof opts === 'object' ? opts : {};
    if (!bot?.entity) return { ok: false, mode: 'none' };
    if (typeof shouldAbort === 'function' && shouldAbort()) return { ok: false, mode: 'abort' };

    if (!options.keepWindow) {
        await closeWindowIfOpen(bot);
    }
    clearKeys(bot);

    // WASD чаще (стабильно); look — по образцу записи
    const mode = Math.random() < 0.65 ? 'wasd' : 'look';
    const tag = mode === 'wasd'
        ? await wasdTap(bot, logFn, shouldAbort)
        : await lookSweep(bot, logFn, shouldAbort);

    clearKeys(bot);
    if (tag === 'abort') return { ok: false, mode: 'abort' };
    return { ok: true, mode: tag };
}
