/**
 * Anti-AFK: паттерн записи пилота (motion-records wire).
 *
 * Эталон: один длинный W, look на ходу, player_input редко (press/release).
 * Look — force=true как в bot-view/pilot.mjs (без await-анимации mineflayer,
 * иначе получаются короткие «рывки»).
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

const TOTAL_DIST_MIN = 28;
const TOTAL_DIST_MAX = 55;
const SESSION_MS_MAX = 22_000;

/** rad/s — как запись. */
const YAW_RATE_MIN = 0.35;
const YAW_RATE_MAX = 0.90;
const YAW_ALIGN = 0.05;

const RETARGET_EVERY_MS_MIN = 1_600;
const RETARGET_EVERY_MS_MAX = 3_500;
const RETARGET_DELTA_MIN = 0.20;
const RETARGET_DELTA_MAX = 0.85;

const TICK_MS = 50;
const PIT_CHECK_EVERY_MS = 280;
const STUCK_MOVE_MIN = 0.15;
const STUCK_CHECK_MS = 700;
const AHEAD_MIN_SAFE = 1.2;

const PITCH_IDLE_MIN = -0.20;
const PITCH_IDLE_MAX = 0.10;

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

/** На ходу: onGround ИЛИ слабый floor-probe (не рвём W из‑за мерцания). */
function canKeepWalking(bot) {
    const ent = bot?.entity;
    if (!ent?.position) return false;
    if (ent.onGround) return true;
    // короткая отрывность (ступенька) — ок
    if (ent.isInWater) return true;
    return isStandingOnFloor(bot);
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

/** Держим W: повторный true no-op в patch, но страхует если кто-то сбросил. */
function holdForward(bot) {
    try {
        bot.setControlState('forward', true);
        bot.setControlState('jump', false);
        bot.setControlState('back', false);
        bot.setControlState('left', false);
        bot.setControlState('right', false);
    } catch {
        /* ignore */
    }
}

/**
 * Instant look как pilot: force=true → сразу yaw/pitch + пакет look/position_look.
 * Не await'им плавный поворот mineflayer (он режет ходьбу на рывки).
 */
function lookInstant(bot, yaw, pitch) {
    if (!bot?.entity) return;
    const p = clampPitch(pitch);
    if (typeof bot.look === 'function') {
        bot.look(yaw, p, true).catch(() => {
            bot.entity.yaw = yaw;
            bot.entity.pitch = p;
        });
    } else {
        bot.entity.yaw = yaw;
        bot.entity.pitch = p;
    }
}

function pickDriftHeading(bot, preferYaw) {
    const sign = Math.random() < 0.5 ? -1 : 1;
    const prefer = preferYaw + sign * rnd(RETARGET_DELTA_MIN, RETARGET_DELTA_MAX);
    let h = pickSafeForwardYaw(bot, prefer);
    if (h == null) h = pickSafeForwardYaw(bot, bot.entity.yaw);
    if (h == null) return null;
    const dy = deltaYaw(h, bot.entity.yaw);
    if (Math.abs(dy) > 1.25) {
        h = bot.entity.yaw + Math.sign(dy) * rnd(0.5, 1.05);
        if (yawWouldFall(bot, h)) h = pickSafeForwardYaw(bot, bot.entity.yaw);
    }
    return h;
}

/**
 * Anti-AFK: press W → долго идём + look на ходу → release W.
 */
export async function antiAFKMoveForwardLook(bot, log = console.log, shouldAbort = null) {
    if (!bot?.entity || !bot.setControlState || typeof bot.look !== 'function') return;
    const logFn = typeof log === 'function' ? log : console.log;
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    await closeWindowIfOpen(bot);
    if (typeof shouldAbort === 'function' && shouldAbort()) return;

    if (!bot.entity.onGround && !isStandingOnFloor(bot)) {
        logFn('anti-AFK look → стоп, нет пола');
        return;
    }

    const totalWant = rnd(TOTAL_DIST_MIN, TOTAL_DIST_MAX);
    const sessionEnd = Date.now() + SESSION_MS_MAX;
    const origin0 = bot.entity.position.clone();
    let stuckN = 0;
    let pitSkips = 0;
    let retargets = 0;
    let airTicks = 0;

    let targetYaw = pickSafeForwardYaw(bot, bot.entity.yaw + rnd(-0.35, 0.35));
    if (targetYaw == null) targetYaw = bot.entity.yaw;
    let targetPitch = clampPitch(rnd(PITCH_IDLE_MIN, PITCH_IDLE_MAX));
    let nextRetargetAt = Date.now() + rndInt(RETARGET_EVERY_MS_MIN, RETARGET_EVERY_MS_MAX);
    let nextPitCheck = Date.now() + PIT_CHECK_EVERY_MS;

    logFn(
        `anti-AFK → continuous W ~${totalWant.toFixed(0)} блоков (look force=true на ходу)`,
    );
    clearWasd(bot);

    try {
        holdForward(bot);

        let stuckOrigin = bot.entity.position.clone();
        let stuckAt = Date.now();
        let lastTick = Date.now();

        while (Date.now() < sessionEnd) {
            if (typeof shouldAbort === 'function' && shouldAbort()) break;

            if (!canKeepWalking(bot)) {
                airTicks += 1;
                if (airTicks > 12) {
                    logFn('anti-AFK look → долго в воздухе, стоп');
                    break;
                }
            } else {
                airTicks = 0;
            }

            const walked = horizDist(origin0, bot.entity.position);
            if (walked >= totalWant) break;

            const now = Date.now();
            const dtSec = Math.min(0.12, Math.max(0.04, (now - lastTick) / 1000));
            lastTick = now;

            // Страховка: W всегда зажат (один player_input при смене)
            holdForward(bot);

            if (now >= nextPitCheck) {
                nextPitCheck = now + PIT_CHECK_EVERY_MS;
                const ahead = maxSafeWalkDist(bot, bot.entity.yaw, 3.5);
                if (ahead < AHEAD_MIN_SAFE || yawWouldFall(bot, bot.entity.yaw)) {
                    pitSkips += 1;
                    const alt = pickSafeForwardYaw(
                        bot,
                        bot.entity.yaw + (Math.random() < 0.5 ? 1 : -1) * rnd(0.6, 1.5),
                    );
                    if (alt == null) {
                        logFn('anti-AFK look → край, некуда рулить');
                        break;
                    }
                    targetYaw = alt;
                    nextRetargetAt = now + rndInt(700, 1_400);
                    retargets += 1;
                }
            } else if (now >= nextRetargetAt) {
                const h = pickDriftHeading(bot, targetYaw);
                if (h != null) {
                    targetYaw = h;
                    if (Math.random() < 0.35) {
                        targetPitch = clampPitch(targetPitch + rnd(-0.05, 0.05));
                    }
                    retargets += 1;
                }
                nextRetargetAt = now + rndInt(RETARGET_EVERY_MS_MIN, RETARGET_EVERY_MS_MAX);
            }

            // Плавный доворот на ходу (instant look packets)
            const dy = deltaYaw(targetYaw, bot.entity.yaw);
            const rate = rnd(YAW_RATE_MIN, YAW_RATE_MAX);
            if (Math.abs(dy) > YAW_ALIGN) {
                const step = Math.sign(dy) * Math.min(Math.abs(dy), rate * dtSec);
                const dp = targetPitch - bot.entity.pitch;
                const pitchStep = Math.sign(dp || 1) * Math.min(Math.abs(dp), rnd(0.01, 0.04));
                lookInstant(
                    bot,
                    bot.entity.yaw + step,
                    bot.entity.pitch + pitchStep,
                );
            } else if (Math.random() < 0.12) {
                lookInstant(
                    bot,
                    bot.entity.yaw,
                    clampPitch(bot.entity.pitch + rnd(-0.02, 0.02)),
                );
            }

            if (now - stuckAt >= STUCK_CHECK_MS) {
                const slid = horizDist(stuckOrigin, bot.entity.position);
                if (slid < STUCK_MOVE_MIN || horizSpeed(bot) < 0.035) {
                    stuckN += 1;
                    const alt = pickSafeForwardYaw(
                        bot,
                        bot.entity.yaw + (Math.random() < 0.5 ? 1 : -1) * rnd(0.9, 2.0),
                    );
                    if (alt == null || stuckN >= 5) break;
                    targetYaw = alt;
                    nextRetargetAt = now + 600;
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
        await awaitSettledOnFloor(bot, { shouldAbort, maxMs: 600 });
    }

    const walked = horizDist(origin0, bot.entity.position);
    logFn(
        `anti-AFK look → конец (walked=${walked.toFixed(1)}/${totalWant.toFixed(1)}, `
        + `retargets=${retargets}, pit=${pitSkips}, stuck=${stuckN})`,
    );
}
