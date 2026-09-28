/**
 * Anti-AFK как ~месяц назад (Aug/Sep 2026), ближе к ванили:
 * - либо короткий WASD (setControlState → patch шлёт player_input только при смене)
 * - либо одиночный поворот: bot.look(..., false) мелкими GCD-шагами (как Aug28)
 * - jump никогда
 * - без маршрутов / ensureGrounded / warp внутри antiAFK
 *
 * Sep9: FunAC цеплял look — поэтому по умолчанию чаще WASD; look реже.
 */

const LOOK_GCD_STEP = 0.15 * (Math.PI / 180);
const WASD_KEYS = ['forward', 'left', 'back', 'right'];

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

/** Одна WASD, 160–420мс — как Sep9 vanilla-move (стабильно снимало AFK). */
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
 * Одиночный поворот как Aug28: look(force=false), мелкие GCD-шаги от текущего yaw.
 * mineflayer сам квантует — ближе к клиенту, чем force=true snap.
 */
async function lookSweep(bot, logFn, shouldAbort) {
    if (!bot?.entity || typeof bot.look !== 'function') return 'look:skip';
    const turnDir = Math.random() < 0.5 ? -1 : 1;
    const steps = rndInt(8, 18);
    const maxPitch = (Math.PI / 2) * 0.22;
    const startPitch = bot.entity.pitch;
    logFn(`anti-AFK → look ${steps} шаг. (force=false)`);
    let done = 0;
    for (let i = 0; i < steps; i++) {
        if (typeof shouldAbort === 'function' && shouldAbort()) break;
        const yawUnits = 2 + rndInt(0, 4);
        const yaw = bot.entity.yaw + turnDir * yawUnits * LOOK_GCD_STEP;
        let pitch = bot.entity.pitch;
        if (Math.random() < 0.15) {
            const pitchUnits = 1 + rndInt(0, 1);
            pitch += (Math.random() < 0.5 ? -1 : 1) * pitchUnits * LOOK_GCD_STEP;
            pitch = Math.max(-maxPitch, Math.min(maxPitch, pitch));
        }
        try {
            await bot.look(yaw, pitch, false);
        } catch {
            break;
        }
        done++;
    }
    const dPitch = Math.abs((bot.entity?.pitch ?? startPitch) - startPitch) * 180 / Math.PI;
    logFn(`anti-AFK → look ${done}/${steps} pitch±${dPitch.toFixed(1)}°`);
    return `look:${done}`;
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

    // Чаще WASD (Sep9: look ловил FunAC). Иногда look как Aug28.
    const mode = Math.random() < 0.7 ? 'wasd' : 'look';
    const tag = mode === 'wasd'
        ? await wasdTap(bot, logFn, shouldAbort)
        : await lookSweep(bot, logFn, shouldAbort);

    clearKeys(bot);
    if (tag === 'abort') return { ok: false, mode: 'abort' };
    return { ok: true, mode: tag };
}
