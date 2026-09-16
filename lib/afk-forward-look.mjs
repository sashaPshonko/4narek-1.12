/**
 * Anti-AFK как у игрока: зажат только forward, направление — мышкой (yaw/pitch).
 * Look через bot.look (sensitivity GCD + yawSpeed physics) → position_look/look как ваниль.
 * Без strafe A/D/S. Pit-guard по yaw ahead.
 */
import {
    awaitSettledOnFloor,
    clearWasd,
    isStandingOnFloor,
    pickSafeForwardYaw,
    yawWouldFall,
} from './wasd-pit-guard.mjs';

const MOVE_BURST_MS_MIN = 3_500;
const MOVE_BURST_MS_MAX = 5_200;
/** Кусок поворота за один bot.look (~человеческий рывок мыши). */
const LOOK_CHUNK_RAD_MIN = 0.07;
const LOOK_CHUNK_RAD_MAX = 0.28;
/** Редкий микро-pause мыши между кусками. */
const LOOK_MICRO_PAUSE_CHANCE = 0.18;
const PITCH_IDLE_MIN = -0.12;
const PITCH_IDLE_MAX = 0.22;

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
    return Math.max(-1.2, Math.min(1.2, p));
}

async function closeWindowIfOpen(bot) {
    if (!bot?.currentWindow) return;
    try {
        await bot.closeWindow(bot.currentWindow);
    } catch {
        /* ignore */
    }
}

/**
 * Плавно довести yaw/pitch кусками через bot.look (force=false → physics GCD).
 * @returns {Promise<boolean>} false если abort
 */
async function mouseLookToward(bot, targetYaw, targetPitch, {
    shouldAbort = null,
    maxMs = 2_400,
} = {}) {
    if (!bot?.look || !bot?.entity) return false;
    const t0 = Date.now();
    const pitchGoal = clampPitch(
        Number.isFinite(targetPitch) ? targetPitch : rnd(PITCH_IDLE_MIN, PITCH_IDLE_MAX),
    );

    while (Date.now() - t0 < maxMs) {
        if (typeof shouldAbort === 'function' && shouldAbort()) return false;
        const yaw = bot.entity.yaw;
        const pitch = bot.entity.pitch;
        const dy = deltaYaw(targetYaw, yaw);
        const dp = pitchGoal - pitch;
        if (Math.abs(dy) < 0.03 && Math.abs(dp) < 0.04) return true;

        const chunk = Math.min(Math.abs(dy), rnd(LOOK_CHUNK_RAD_MIN, LOOK_CHUNK_RAD_MAX));
        const nextYaw = yaw + Math.sign(dy || 1) * chunk;
        const nextPitch = clampPitch(pitch + Math.sign(dp || 1) * Math.min(Math.abs(dp), rnd(0.02, 0.08)));

        try {
            // force=false: mineflayer ждёт, пока physics догонит lastSent (ванильный yawSpeed)
            await bot.look(nextYaw, nextPitch, false);
        } catch {
            return false;
        }
        if (Math.random() < LOOK_MICRO_PAUSE_CHANCE) {
            await sleep(rndInt(40, 110));
        }
    }
    return true;
}

async function releaseForward(bot) {
    try {
        bot.setControlState('forward', false);
    } catch {
        /* ignore */
    }
}

/**
 * Бурст: W зажат, повороты мышкой к безопасному yaw.
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

    const burstMs = rndInt(MOVE_BURST_MS_MIN, MOVE_BURST_MS_MAX);
    const endAt = Date.now() + burstMs;
    logFn(`anti-AFK → forward+мышь ~${(burstMs / 1000).toFixed(1)}с`);

    let pitSkips = 0;
    let steerN = 0;
    clearWasd(bot);

    try {
        // Стартовый разворот на месте, если прямо в яму
        let heading = pickSafeForwardYaw(bot, bot.entity.yaw);
        if (heading == null) {
            logFn('anti-AFK look → нет безопасного yaw (край/яма)');
            await awaitSettledOnFloor(bot, { shouldAbort });
            return;
        }
        const startDy = Math.abs(deltaYaw(heading, bot.entity.yaw));
        if (startDy > 0.12) {
            // большой поворот — без W (как игрок крутит камеру стоя)
            if (startDy > 0.9) {
                await releaseForward(bot);
            }
            const ok = await mouseLookToward(bot, heading, rnd(PITCH_IDLE_MIN, PITCH_IDLE_MAX), {
                shouldAbort,
                maxMs: 2_800,
            });
            if (!ok) return;
            steerN++;
        }

        bot.setControlState('forward', true);

        while (Date.now() < endAt) {
            if (typeof shouldAbort === 'function' && shouldAbort()) break;
            if (!isStandingOnFloor(bot)) {
                logFn('anti-AFK look → пол пропал');
                break;
            }
            if (yawWouldFall(bot, bot.entity.yaw)) {
                pitSkips++;
                await releaseForward(bot);
                await awaitSettledOnFloor(bot, { shouldAbort, maxMs: 900 });
                heading = pickSafeForwardYaw(bot, bot.entity.yaw);
                if (heading == null) {
                    logFn('anti-AFK look → край, некуда');
                    break;
                }
                await mouseLookToward(bot, heading, rnd(PITCH_IDLE_MIN, PITCH_IDLE_MAX), {
                    shouldAbort,
                    maxMs: 2_200,
                });
                steerN++;
                if (typeof shouldAbort === 'function' && shouldAbort()) break;
                if (!isStandingOnFloor(bot)) break;
                bot.setControlState('forward', true);
                continue;
            }

            // во время W: лёгкий дрейф курса / доворот к новому safe heading
            const wander = pickSafeForwardYaw(
                bot,
                bot.entity.yaw + rnd(-0.45, 0.45),
            );
            if (wander != null) {
                const dy = deltaYaw(wander, bot.entity.yaw);
                // мелкий поворот — не отпуская W; крупный — отпустить
                if (Math.abs(dy) > 0.85) {
                    await releaseForward(bot);
                    await mouseLookToward(bot, wander, bot.entity.pitch + rnd(-0.05, 0.05), {
                        shouldAbort,
                        maxMs: 1_800,
                    });
                    steerN++;
                    bot.setControlState('forward', true);
                } else if (Math.abs(dy) > 0.06) {
                    const chunk = Math.sign(dy) * Math.min(Math.abs(dy), rnd(0.05, 0.18));
                    try {
                        await bot.look(
                            bot.entity.yaw + chunk,
                            clampPitch(bot.entity.pitch + rnd(-0.03, 0.04)),
                            false,
                        );
                    } catch {
                        break;
                    }
                    steerN++;
                }
            }

            // держим W, тикаем ~0.35–0.75с между микро-поворотами
            const holdUntil = Date.now() + rndInt(350, 750);
            while (Date.now() < holdUntil && Date.now() < endAt) {
                if (typeof shouldAbort === 'function' && shouldAbort()) break;
                if (!isStandingOnFloor(bot) || yawWouldFall(bot, bot.entity.yaw)) {
                    break;
                }
                await sleep(Math.min(40, holdUntil - Date.now()));
            }
        }
    } finally {
        clearWasd(bot);
    }

    logFn(`anti-AFK look → конец (steer=${steerN}, pit=${pitSkips})`);
}
