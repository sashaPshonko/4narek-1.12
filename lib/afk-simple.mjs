/**
 * Простой anti-AFK «как клиент» по wire-записям пилота:
 * - look: force=true, только целые шаги мыши (GCD 0.15°)
 * - редкий player_input: короткое нажатие W / иногда strafe
 * - без маршрутов, pit-A*, длинных сессий
 *
 * Эталон: motion-records/* — look ~каждые 50мс по 3–12 GCD-юнитов,
 * player_input редко (press/release), не каждый тик.
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
        for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
            bot.setControlState(k, false);
        }
        bot.refreshPlayerInput?.();
    } catch {
        /* ignore */
    }
}

/**
 * Один тик мыши к цели: целые GCD-шаги, без snap на весь Δyaw.
 * Как в записи: p50 ≈ 5 юнитов / 50мс при повороте.
 */
async function lookTickToward(bot, targetYaw, targetPitch, maxUnits = 12) {
    if (!bot?.entity || typeof bot.look !== 'function') return;
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
            /* ignore */
        }
    }
}

function horizDist(a, b) {
    if (!a || !b) return 0;
    return Math.hypot((b.x - a.x) || 0, (b.z - a.z) || 0);
}

/**
 * Короткая клиентская активность для снятия AFK / «осмотра».
 * @returns {Promise<number>} пройденный xz (может быть 0 при look-only)
 */
export async function clientLikeUnAfk(bot, log = console.log, shouldAbort = null, opts = null) {
    const logFn = typeof log === 'function' ? log : console.log;
    const options = opts && typeof opts === 'object' ? opts : {};
    if (!bot?.entity) return 0;
    if (typeof shouldAbort === 'function' && shouldAbort()) return 0;

    if (bot.currentWindow) {
        try {
            await bot.closeWindow(bot.currentWindow);
        } catch {
            /* ignore */
        }
    }

    const origin = bot.entity.position.clone();
    const modeRoll = Math.random();
    // ~55% W+look, ~30% look-only, ~15% strafe+look — как живой тычок, не маршрут
    const mode = modeRoll < 0.55 ? 'forward' : modeRoll < 0.85 ? 'look' : 'strafe';
    const holdMs = mode === 'look' ? rndInt(700, 1400) : rndInt(900, 2200);
    const targetYaw = normalizeAngle(
        bot.entity.yaw + (Math.random() < 0.5 ? -1 : 1) * rnd(0.35, 1.35),
    );
    const targetPitch = clampPitch(rnd(-0.25, 0.12));

    logFn(`anti-AFK → client ${mode} ~${Math.round(holdMs / 100) / 10}с`);

    clearKeys(bot);
    try {
        if (mode === 'forward') {
            bot.setControlState('forward', true);
            bot.refreshPlayerInput?.();
        } else if (mode === 'strafe') {
            const key = Math.random() < 0.5 ? 'left' : 'right';
            bot.setControlState(key, true);
            bot.refreshPlayerInput?.();
        }

        const until = Date.now() + holdMs;
        while (Date.now() < until) {
            if (typeof shouldAbort === 'function' && shouldAbort()) break;
            await lookTickToward(bot, targetYaw, targetPitch, rndInt(3, 12));
            await sleep(TICK_MS);
        }
    } finally {
        clearKeys(bot);
    }

    // мягкий jump, если почти не сдвинулись (FunTime часто снимает AFK от jump)
    let walked = horizDist(origin, bot.entity?.position);
    if (walked < 0.4 && bot.entity?.onGround) {
        try {
            bot.setControlState('jump', true);
            bot.refreshPlayerInput?.();
            await sleep(280);
            bot.setControlState('jump', false);
            bot.refreshPlayerInput?.();
            await sleep(350);
            // чуть докрутить голову после прыжка
            await lookTickToward(bot, targetYaw, targetPitch, rndInt(4, 10));
        } catch {
            /* ignore */
        }
        walked = Math.max(walked, horizDist(origin, bot.entity?.position));
        if (walked < 0.35) walked = 1.0; // jump-on-spot как soft un-AFK
    }

    return walked;
}

export function nextSimpleWalkGapMs() {
    // реже дёргаемся: 70–140с между «осмотрами»
    return 70_000 + Math.floor(Math.random() * 70_000);
}
