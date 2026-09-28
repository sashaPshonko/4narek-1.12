/**
 * Anti-AFK only (как wire-запись пилота). Без jump. Без прогулок.
 *
 * Либо одно из двух:
 * 1) WASD — редкий press/release (как player_input в записи)
 * 2) одиночный поворот головы — force=true, только целые GCD-шаги мыши 0.15°
 */

const LOOK_GCD_STEP = 0.15 * (Math.PI / 180);
const YAW_DEADBAND = 0.04;
const TICK_MS = 50;

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
    return Math.max(-0.9, Math.min(0.6, p));
}

function clearKeys(bot) {
    if (!bot?.setControlState) return;
    try {
        // jump никогда не жмём — но на всякий сбрасываем, если кто-то оставил
        for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
            bot.setControlState(k, false);
        }
        bot.refreshPlayerInput?.();
    } catch {
        /* ignore */
    }
}

async function lookTickToward(bot, targetYaw, targetPitch, maxUnits = 12) {
    if (!bot?.entity || typeof bot.look !== 'function') return false;
    const curYaw = bot.entity.yaw;
    const curPitch = bot.entity.pitch;
    const dy = deltaYaw(targetYaw, curYaw);
    let nextYaw = curYaw;
    if (Math.abs(dy) > YAW_DEADBAND) {
        const units = Math.min(maxUnits, Math.max(1, Math.floor(Math.abs(dy) / LOOK_GCD_STEP)));
        nextYaw = normalizeAngle(curYaw + Math.sign(dy) * units * LOOK_GCD_STEP);
    }
    let nextPitch = curPitch;
    const dp = targetPitch - curPitch;
    if (Math.abs(dp) > LOOK_GCD_STEP) {
        const pu = Math.min(4, Math.max(1, Math.floor(Math.abs(dp) / LOOK_GCD_STEP)));
        nextPitch = curPitch + Math.sign(dp) * pu * LOOK_GCD_STEP;
    }
    nextPitch = clampPitch(nextPitch);
    try {
        await bot.look(nextYaw, nextPitch, true);
        bot.entity.yaw = nextYaw;
        bot.entity.pitch = nextPitch;
    } catch {
        try {
            bot.entity.yaw = nextYaw;
            bot.entity.pitch = nextPitch;
        } catch {
            return false;
        }
    }
    return Math.abs(deltaYaw(targetYaw, nextYaw)) <= YAW_DEADBAND * 2;
}

/**
 * @returns {Promise<{ ok: boolean, mode: string }>}
 */
export async function clientLikeUnAfk(bot, log = console.log, shouldAbort = null) {
    const logFn = typeof log === 'function' ? log : console.log;
    if (!bot?.entity) return { ok: false, mode: 'none' };
    if (typeof shouldAbort === 'function' && shouldAbort()) return { ok: false, mode: 'abort' };

    if (bot.currentWindow) {
        try {
            await bot.closeWindow(bot.currentWindow);
        } catch {
            /* ignore */
        }
    }

    clearKeys(bot);

    // строго XOR: либо WASD, либо один поворот — не вместе
    const mode = Math.random() < 0.55 ? 'wasd' : 'look';

    if (mode === 'wasd') {
        const key = ['forward', 'back', 'left', 'right'][rndInt(0, 3)];
        const holdMs = rndInt(550, 1400);
        logFn(`anti-AFK → WASD ${key} ~${Math.round(holdMs / 100) / 10}с`);
        try {
            bot.setControlState(key, true);
            bot.refreshPlayerInput?.();
            const until = Date.now() + holdMs;
            while (Date.now() < until) {
                if (typeof shouldAbort === 'function' && shouldAbort()) break;
                await sleep(TICK_MS);
            }
        } finally {
            clearKeys(bot);
        }
        return { ok: true, mode: `wasd:${key}` };
    }

    // одиночный поворот: одна цель yaw/pitch, докручиваем GCD-шагами как в записи
    const targetYaw = normalizeAngle(
        bot.entity.yaw + (Math.random() < 0.5 ? -1 : 1) * rnd(0.45, 1.25),
    );
    const targetPitch = clampPitch(bot.entity.pitch + rnd(-0.12, 0.08));
    const maxMs = rndInt(500, 1100);
    logFn(`anti-AFK → look ~${Math.round(maxMs / 100) / 10}с`);
    const until = Date.now() + maxMs;
    let done = false;
    while (Date.now() < until) {
        if (typeof shouldAbort === 'function' && shouldAbort()) break;
        done = await lookTickToward(bot, targetYaw, targetPitch, rndInt(3, 10));
        if (done) break;
        await sleep(TICK_MS);
    }
    return { ok: true, mode: 'look' };
}
