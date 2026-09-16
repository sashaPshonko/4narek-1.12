/**
 * Anti-AFK: только W + мышь (без A/D/S/jump).
 *
 * Сначала план: heading + дистанция по safe-полу.
 * Угол поворота = Δyaw до heading; W держим пока не прошли dist
 * (не по таймеру). Пакеты как раньше: bot.look(force=false) + setControlState
 * → vanilla-move шлёт player_input / look / tick_end.
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

/** Сколько ног суммарно пройти за один anti-AFK вызов. */
const TOTAL_DIST_MIN = 3.5;
const TOTAL_DIST_MAX = 7.5;
/** Одна нога: желаемая длина (потом режется maxSafeWalkDist). */
const LEG_DIST_MIN = 1.2;
const LEG_DIST_MAX = 4.2;
/** Жёсткий потолок на всю сессию (защита от зависания). */
const SESSION_MS_MAX = 9_000;
/** На ногу: не дольше чем dist / мин.скорость + запас. */
const WALK_SPEED_MIN = 0.12;
const LEG_TIMEOUT_PAD_MS = 1_200;
const LEG_PAUSE_MS_MIN = 80;
const LEG_PAUSE_MS_MAX = 280;

const LOOK_STEP_SMALL_MIN = 0.025;
const LOOK_STEP_SMALL_MAX = 0.11;
const LOOK_STEP_BIG_MIN = 0.14;
const LOOK_STEP_BIG_MAX = 0.32;
const LOOK_MICRO_PAUSE_CHANCE = 0.22;
const PITCH_IDLE_MIN = -0.28;
const PITCH_IDLE_MAX = 0.18;

const STUCK_MOVE_MIN = 0.08;
const STUCK_CHECK_MS = 450;
/** Считаем курс набранным. */
const YAW_ALIGN = 0.05;

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

function pickPitch(prefer = null) {
    if (Number.isFinite(prefer)) return clampPitch(prefer + rnd(-0.04, 0.04));
    if (Math.random() < 0.65) return clampPitch(rnd(-0.08, 0.06));
    return clampPitch(rnd(PITCH_IDLE_MIN, PITCH_IDLE_MAX));
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

/** Плавно к targetYaw — угол задан целью, не рандомом. */
async function mouseLookToward(bot, targetYaw, targetPitch, {
    shouldAbort = null,
    maxMs = 2_400,
} = {}) {
    if (!bot?.look || !bot?.entity) return false;
    const t0 = Date.now();
    const pitchGoal = pickPitch(targetPitch);
    const turnAbs = Math.abs(deltaYaw(targetYaw, bot.entity.yaw));
    const budget = Math.min(maxMs, 350 + turnAbs * 1_100);

    while (Date.now() - t0 < budget) {
        if (typeof shouldAbort === 'function' && shouldAbort()) return false;
        const yaw = bot.entity.yaw;
        const pitch = bot.entity.pitch;
        const dy = deltaYaw(targetYaw, yaw);
        const dp = pitchGoal - pitch;
        if (Math.abs(dy) < YAW_ALIGN && Math.abs(dp) < 0.04) return true;

        const step = Math.abs(dy) > 0.7
            ? rnd(LOOK_STEP_BIG_MIN, LOOK_STEP_BIG_MAX)
            : rnd(LOOK_STEP_SMALL_MIN, LOOK_STEP_SMALL_MAX);
        const chunk = Math.min(Math.abs(dy), step);
        const nextYaw = yaw + Math.sign(dy || 1) * chunk;
        const nextPitch = clampPitch(
            pitch + Math.sign(dp || 1) * Math.min(Math.abs(dp), rnd(0.015, 0.07)),
        );

        try {
            await bot.look(nextYaw, nextPitch, false);
        } catch {
            return false;
        }
        if (Math.random() < LOOK_MICRO_PAUSE_CHANCE) {
            await sleep(rndInt(35, 100));
        }
    }
    return Math.abs(deltaYaw(targetYaw, bot.entity.yaw)) < 0.12;
}

/** На ходу только доворачиваем к запланированному heading. */
async function mouseKeepHeading(bot, heading, shouldAbort) {
    if (!bot?.look || !bot?.entity) return false;
    if (typeof shouldAbort === 'function' && shouldAbort()) return false;
    const dy = deltaYaw(heading, bot.entity.yaw);
    if (Math.abs(dy) < YAW_ALIGN) {
        if (Math.random() < 0.25) {
            try {
                await bot.look(
                    bot.entity.yaw,
                    clampPitch(bot.entity.pitch + rnd(-0.025, 0.025)),
                    false,
                );
            } catch {
                return false;
            }
        }
        return true;
    }
    const step = Math.sign(dy) * Math.min(Math.abs(dy), rnd(LOOK_STEP_SMALL_MIN, LOOK_STEP_SMALL_MAX));
    try {
        await bot.look(
            bot.entity.yaw + step,
            clampPitch(bot.entity.pitch + rnd(-0.02, 0.025)),
            false,
        );
        return true;
    } catch {
        return false;
    }
}

/**
 * План одной ноги: куда смотреть и сколько блоков идти.
 * @returns {{ heading: number, dist: number, turn: number } | null}
 */
function planLeg(bot, remainingDist) {
    if (!bot?.entity || remainingDist < 0.5) return null;
    const prefer = bot.entity.yaw + rnd(-1.1, 1.1);
    let heading = pickSafeForwardYaw(bot, prefer);
    if (heading == null) heading = pickSafeForwardYaw(bot, bot.entity.yaw);
    if (heading == null) return null;

    const want = Math.min(remainingDist, rnd(LEG_DIST_MIN, LEG_DIST_MAX));
    const safe = maxSafeWalkDist(bot, heading, want);
    if (safe < 0.7) {
        // попробовать другой курс с большей дистанцией
        for (let i = 0; i < 6; i++) {
            const alt = pickSafeForwardYaw(bot, bot.entity.yaw + rnd(-Math.PI, Math.PI));
            if (alt == null) continue;
            const d = maxSafeWalkDist(bot, alt, want);
            if (d >= 0.7) {
                return {
                    heading: alt,
                    dist: d,
                    turn: deltaYaw(alt, bot.entity.yaw),
                };
            }
        }
        return null;
    }
    return {
        heading,
        dist: safe,
        turn: deltaYaw(heading, bot.entity.yaw),
    };
}

/**
 * Anti-AFK: план → поворот на угол плана → W до дистанции плана.
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
    let walked = 0;
    let legs = 0;
    let pitSkips = 0;
    let stuckN = 0;

    logFn(`anti-AFK → план ~${totalWant.toFixed(1)} блоков (W по дистанции, мышь по курсу)`);
    clearWasd(bot);

    try {
        while (walked < totalWant - 0.4 && Date.now() < sessionEnd) {
            if (typeof shouldAbort === 'function' && shouldAbort()) break;
            if (!isStandingOnFloor(bot)) {
                logFn('anti-AFK look → пол пропал');
                break;
            }

            const leg = planLeg(bot, totalWant - walked);
            if (!leg) {
                pitSkips++;
                logFn('anti-AFK look → некуда планировать');
                await awaitSettledOnFloor(bot, { shouldAbort, maxMs: 900 });
                break;
            }

            const turnAbs = Math.abs(leg.turn);
            logFn(
                `anti-AFK нога: dist=${leg.dist.toFixed(1)} turn=${(turnAbs * 180 / Math.PI).toFixed(0)}°`,
            );

            // 1) поворот стоя — угол из плана
            if (turnAbs > YAW_ALIGN) {
                await releaseForward(bot);
                const ok = await mouseLookToward(bot, leg.heading, pickPitch(bot.entity.pitch), {
                    shouldAbort,
                });
                if (!ok) break;
            }

            if (typeof shouldAbort === 'function' && shouldAbort()) break;
            if (yawWouldFall(bot, bot.entity.yaw)) {
                pitSkips++;
                continue;
            }

            // 2) W пока не прошли leg.dist
            const origin = bot.entity.position.clone();
            const legTimeout = Math.min(
                sessionEnd - Date.now(),
                (leg.dist / WALK_SPEED_MIN) * 1000 + LEG_TIMEOUT_PAD_MS,
            );
            const walkUntil = Date.now() + Math.max(800, legTimeout);
            const stuckOrigin = origin.clone();
            let stuckAt = Date.now();
            let stuckThis = false;
            legs += 1;

            try {
                bot.setControlState('forward', true);
                bot.setControlState('jump', false);

                while (Date.now() < walkUntil) {
                    if (typeof shouldAbort === 'function' && shouldAbort()) break;
                    if (!isStandingOnFloor(bot) || yawWouldFall(bot, bot.entity.yaw)) {
                        pitSkips++;
                        break;
                    }

                    const gone = horizDist(origin, bot.entity.position);
                    if (gone >= leg.dist) break;

                    // держим запланированный heading (пакеты look)
                    if (Math.random() < 0.35) {
                        await mouseKeepHeading(bot, leg.heading, shouldAbort);
                    }

                    if (Date.now() - stuckAt >= STUCK_CHECK_MS) {
                        const slid = horizDist(stuckOrigin, bot.entity.position);
                        if (slid < STUCK_MOVE_MIN || horizSpeed(bot) < 0.035) {
                            stuckThis = true;
                            stuckN += 1;
                            break;
                        }
                        stuckOrigin.x = bot.entity.position.x;
                        stuckOrigin.y = bot.entity.position.y;
                        stuckOrigin.z = bot.entity.position.z;
                        stuckAt = Date.now();
                    }

                    await sleep(40);
                }
            } finally {
                await releaseForward(bot);
            }

            walked += horizDist(origin, bot.entity.position);

            if (stuckThis) {
                const altPrefer = bot.entity.yaw + (Math.random() < 0.5 ? 1 : -1) * rnd(1.0, 2.4);
                const alt = pickSafeForwardYaw(bot, altPrefer);
                if (alt != null) {
                    await mouseLookToward(bot, alt, pickPitch(), { shouldAbort });
                }
            }

            const pauseUntil = Math.min(
                Date.now() + rndInt(LEG_PAUSE_MS_MIN, LEG_PAUSE_MS_MAX),
                sessionEnd,
            );
            while (Date.now() < pauseUntil) {
                if (typeof shouldAbort === 'function' && shouldAbort()) break;
                await sleep(Math.min(40, pauseUntil - Date.now()));
            }
        }
    } finally {
        clearWasd(bot);
        try { bot.setControlState('jump', false); } catch { /* ignore */ }
    }

    logFn(
        `anti-AFK look → конец (walked=${walked.toFixed(1)}/${totalWant.toFixed(1)}, legs=${legs}, pit=${pitSkips}, stuck=${stuckN})`,
    );
}
