/**
 * Anti-AFK: паттерн как в записи пилота (motion-records wire).
 *
 * Эталон (2026-09-16T22-25…): один длинный W (~20с / ~80 блоков),
 * поворот во время ходьбы (yaw rate ~0.3–1.0 rad/s), wire =
 * tick_end ↔ position_look / position, player_input редко (press/release).
 *
 * Не реплей трека: только ритм. Пакеты — через bot.look(force=false) +
 * setControlState → vanilla-move (как раньше).
 */
import {
    awaitSettledOnFloor,
    clearWasd,
    horizSpeed,
    isStandingOnFloor,
    maxSafeWalkDist,
    pickSafeForwardYaw,
    yawWouldFall,
} from './wasd-pit-guard.mjs';

/** Длинный ход как в записи (не 4–7 блоков). */
const TOTAL_DIST_MIN = 28;
const TOTAL_DIST_MAX = 55;
const SESSION_MS_MAX = 22_000;

/** Скорость доворота на ходу — как p25–p75 записи. */
const YAW_RATE_MIN = 0.32;
const YAW_RATE_MAX = 0.95;
/** Пока |Δyaw| меньше — почти прямо, редкий micro-pitch. */
const YAW_ALIGN = 0.04;
/** Новый целевой курс: плавный дрейф, не разворот на месте. */
const RETARGET_EVERY_MS_MIN = 1_400;
const RETARGET_EVERY_MS_MAX = 3_200;
const RETARGET_DELTA_MIN = 0.25;
const RETARGET_DELTA_MAX = 0.95;

const TICK_MS = 45;
const STUCK_MOVE_MIN = 0.12;
const STUCK_CHECK_MS = 550;
const AHEAD_MIN_SAFE = 1.6;

const PITCH_IDLE_MIN = -0.22;
const PITCH_IDLE_MAX = 0.12;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function rnd(min, max) {
    return min + Math.random() * (max - min);
}

function rndInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
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

function horizDist(a, b) {
    if (!a || !b) return 0;
    return Math.hypot((b.x - a.x) || 0, (b.z - a.z) || 0);
}

async function closeWindowIfOpen(bot) {
    if (!bot?.currentWindow) return;
    try {
        await bot.closeWindow(bot.currentWindow);
    } catch {
        /* ignore */
    }
}

async function releaseForward(bot) {
    try {
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
    } catch {
        /* ignore */
    }
}

/**
 * Один look-шаг к targetYaw/pitch с человеческой скоростью (на ходу).
 * @returns {number} оставшийся |Δyaw|
 */
async function lookStepWhileMoving(bot, targetYaw, targetPitch, dtSec) {
    if (!bot?.look || !bot?.entity) return 0;
    const yaw = bot.entity.yaw;
    const pitch = bot.entity.pitch;
    const dy = deltaYaw(targetYaw, yaw);
    const dp = targetPitch - pitch;
    const rate = rnd(YAW_RATE_MIN, YAW_RATE_MAX);
    const maxStep = rate * Math.max(0.03, dtSec);
    const stepYaw = Math.sign(dy || 1) * Math.min(Math.abs(dy), maxStep);
    const stepPitch = Math.sign(dp || 1) * Math.min(Math.abs(dp), rnd(0.012, 0.045));
    try {
        // force=false → vanilla position_look / look как в записи
        await bot.look(yaw + stepYaw, clampPitch(pitch + stepPitch), false);
    } catch {
        return Math.abs(dy);
    }
    return Math.abs(dy) - Math.abs(stepYaw);
}

/** Выбрать безопасный курс рядом с prefer (для дрейфа на ходу). */
function pickDriftHeading(bot, preferYaw) {
    const prefer = preferYaw + rnd(
        (Math.random() < 0.5 ? -1 : 1) * RETARGET_DELTA_MIN,
        (Math.random() < 0.5 ? -1 : 1) * RETARGET_DELTA_MAX,
    );
    let h = pickSafeForwardYaw(bot, prefer);
    if (h == null) h = pickSafeForwardYaw(bot, bot.entity.yaw);
    if (h == null) return null;
    // не разворачиваться резко: ограничить смену относительно текущего
    const dy = deltaYaw(h, bot.entity.yaw);
    if (Math.abs(dy) > 1.35) {
        h = bot.entity.yaw + Math.sign(dy) * rnd(0.55, 1.15);
        if (yawWouldFall(bot, h)) {
            h = pickSafeForwardYaw(bot, bot.entity.yaw);
        }
    }
    return h;
}

/**
 * Anti-AFK: зажать W → идти далеко → крутить мышь на ходу → отпустить W.
 */
export async function antiAFKMoveForwardLook(bot, log = console.log, shouldAbort = null) {
    if (!bot?.entity || !bot.setControlState || typeof bot.look !== 'function') return;
    const logFn = typeof log === 'function' ? log : console.log;
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    await closeWindowIfOpen(bot);
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    if (!isStandingOnFloor(bot)) {
        logFn('anti-AFK look → стоп, нет пола');
        return;
    }

    const totalWant = rnd(TOTAL_DIST_MIN, TOTAL_DIST_MAX);
    const sessionEnd = Date.now() + SESSION_MS_MAX;
    const origin0 = bot.entity.position.clone();
    let walked = 0;
    let stuckN = 0;
    let pitSkips = 0;
    let retargets = 0;

    let targetYaw = pickSafeForwardYaw(bot, bot.entity.yaw + rnd(-0.4, 0.4));
    if (targetYaw == null) targetYaw = bot.entity.yaw;
    let targetPitch = clampPitch(rnd(PITCH_IDLE_MIN, PITCH_IDLE_MAX));
    let nextRetargetAt = Date.now() + rndInt(RETARGET_EVERY_MS_MIN, RETARGET_EVERY_MS_MAX);

    logFn(
        `anti-AFK → continuous W ~${totalWant.toFixed(0)} блоков (поворот на ходу, как запись)`,
    );
    clearWasd(bot);

    try {
        // Как в записи: один press forward, потом долго держим
        bot.setControlState('forward', true);
        bot.setControlState('jump', false);

        let stuckOrigin = bot.entity.position.clone();
        let stuckAt = Date.now();
        let lastTick = Date.now();

        while (Date.now() < sessionEnd) {
            if (typeof shouldAbort === 'function' && shouldAbort()) break;
            if (!isStandingOnFloor(bot)) {
                logFn('anti-AFK look → пол пропал');
                break;
            }

            walked = horizDist(origin0, bot.entity.position);
            if (walked >= totalWant) break;

            const now = Date.now();
            const dtSec = Math.min(0.12, Math.max(0.03, (now - lastTick) / 1000));
            lastTick = now;

            // Впереди мало места → сменить курс, W не отпускаем
            const ahead = maxSafeWalkDist(bot, bot.entity.yaw, 4.5);
            if (ahead < AHEAD_MIN_SAFE || yawWouldFall(bot, bot.entity.yaw)) {
                pitSkips += 1;
                const alt = pickSafeForwardYaw(
                    bot,
                    bot.entity.yaw + (Math.random() < 0.5 ? 1 : -1) * rnd(0.7, 1.6),
                );
                if (alt == null) {
                    logFn('anti-AFK look → край, некуда рулить');
                    break;
                }
                targetYaw = alt;
                nextRetargetAt = now + rndInt(900, 1_800);
                retargets += 1;
            } else if (now >= nextRetargetAt) {
                const h = pickDriftHeading(bot, targetYaw);
                if (h != null) {
                    targetYaw = h;
                    targetPitch = clampPitch(
                        targetPitch + rnd(-0.06, 0.06) * (Math.random() < 0.4 ? 1 : 0),
                    );
                    retargets += 1;
                }
                nextRetargetAt = now + rndInt(RETARGET_EVERY_MS_MIN, RETARGET_EVERY_MS_MAX);
            }

            // Look на ходу → position_look в wire (паттерн записи)
            const remain = Math.abs(deltaYaw(targetYaw, bot.entity.yaw));
            if (remain > YAW_ALIGN || Math.random() < 0.18) {
                await lookStepWhileMoving(bot, targetYaw, targetPitch, dtSec);
            }

            if (now - stuckAt >= STUCK_CHECK_MS) {
                const slid = horizDist(stuckOrigin, bot.entity.position);
                if (slid < STUCK_MOVE_MIN || horizSpeed(bot) < 0.04) {
                    stuckN += 1;
                    const alt = pickSafeForwardYaw(
                        bot,
                        bot.entity.yaw + (Math.random() < 0.5 ? 1 : -1) * rnd(1.0, 2.2),
                    );
                    if (alt == null) break;
                    targetYaw = alt;
                    // короткий «рывок» курса без отпускания W
                    nextRetargetAt = now + 800;
                    if (stuckN >= 4) break;
                }
                stuckOrigin = bot.entity.position.clone();
                stuckAt = now;
            }

            await sleep(TICK_MS);
        }
    } finally {
        await releaseForward(bot);
        clearWasd(bot);
        try { bot.setControlState('jump', false); } catch { /* ignore */ }
        await awaitSettledOnFloor(bot, { shouldAbort, maxMs: 700 });
    }

    walked = horizDist(origin0, bot.entity.position);
    logFn(
        `anti-AFK look → конец (walked=${walked.toFixed(1)}/${totalWant.toFixed(1)}, `
        + `retargets=${retargets}, pit=${pitSkips}, stuck=${stuckN})`,
    );
}
