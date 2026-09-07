/**
 * Прогулка по вейпоинтам: аккуратный поворот головы → прямая до точки → повтор.
 * Точки — walk-route.json (правка без рестарта воркера).
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    shouldAttemptWarp as shouldAttemptWalk,
    warpCooldownMs as walkCooldownMs,
    warpStartupDelayMs as walkStartupDelayMs,
} from './warp-pick.mjs';

export { shouldAttemptWalk, walkCooldownMs, walkStartupDelayMs };

const ORCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WALK_ROUTE_PATH = join(ORCH_ROOT, 'walk-route.json');

/** Шаг мыши vanilla 100% — как старый осмотр до короткого anti-AFK. */
const LOOK_GCD_STEP = 0.15 * (Math.PI / 180);
const LOOK_SEGMENT_PAUSE_MIN_MS = 40;
const LOOK_SEGMENT_PAUSE_MAX_MS = 160;
const TICK_MS = 50;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function rndInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function normalizeAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}

function xzDist(ax, az, bx, bz) {
    return Math.hypot(ax - bx, az - bz);
}

/** mineflayer: yaw 0 = +Z, против часовой к −X. */
function yawTo(fromX, fromZ, toX, toZ) {
    return Math.atan2(-(toX - fromX), toZ - fromZ);
}

/**
 * @param {unknown} raw
 * @returns {{ x: number, y: number, z: number }[]}
 */
export function parseRoutePoints(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const p of raw) {
        if (!p || typeof p !== 'object') continue;
        const x = Number(p.x);
        const y = Number(p.y);
        const z = Number(p.z);
        if (![x, y, z].every(Number.isFinite)) continue;
        out.push({ x, y, z });
    }
    return out;
}

/** Длина замкнутого/разомкнутого пути по XZ. */
export function routeTotalLength(points, loop = true) {
    if (!points?.length || points.length < 2) return 0;
    const edges = loop ? points.length : points.length - 1;
    let total = 0;
    for (let i = 0; i < edges; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        total += xzDist(a.x, a.z, b.x, b.z);
    }
    return total;
}

/**
 * Точка на дуге s метров от points[fromIdx] вдоль маршрута.
 * @returns {{ x: number, y: number, z: number, endIdx: number, traveled: number } | null}
 */
export function pointAlongRoute(points, fromIdx, s, loop = true) {
    if (!points?.length || points.length < 2 || !(s > 0)) return null;
    const n = points.length;
    let left = s;
    let i = fromIdx;
    const maxHops = loop ? n : n - 1;
    for (let hop = 0; hop < maxHops; hop++) {
        const a = points[i];
        const j = (i + 1) % n;
        if (!loop && j === 0) break;
        const b = points[j];
        const len = xzDist(a.x, a.z, b.x, b.z);
        if (len < 1e-6) {
            i = j;
            continue;
        }
        if (left <= len) {
            const t = left / len;
            return {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
                z: a.z + (b.z - a.z) * t,
                endIdx: j,
                traveled: s,
            };
        }
        left -= len;
        i = j;
    }
    const last = points[i];
    return { x: last.x, y: last.y, z: last.z, endIdx: i, traveled: s - left };
}

/** Читает JSON каждый вызов — правки точек без рестарта воркера. */
export function loadWalkRoute(filePath = WALK_ROUTE_PATH) {
    const fallback = {
        loop: true,
        arriveXZ: 1.25,
        maxMs: 180_000,
        stopFracMin: 0.25,
        stopFracMax: 0.5,
        lookAlignRad: 0.09,
        lookMaxMs: 5500,
        preWalkChat: null,
        preWalkChatWaitMs: 3500,
        /** /spawn при stuck или если уже в ловушке z≈21 */
        spawnOnStuck: true,
        spawnWaitMs: 3500,
        points: [],
    };
    if (!existsSync(filePath)) {
        return { ...fallback, filePath, missing: true };
    }
    try {
        const j = JSON.parse(readFileSync(filePath, 'utf8'));
        const points = parseRoutePoints(j.points);
        let stopFracMin = Number(j.stopFracMin);
        let stopFracMax = Number(j.stopFracMax);
        if (!Number.isFinite(stopFracMin)) stopFracMin = fallback.stopFracMin;
        if (!Number.isFinite(stopFracMax)) stopFracMax = fallback.stopFracMax;
        stopFracMin = Math.max(0.05, Math.min(0.95, stopFracMin));
        stopFracMax = Math.max(stopFracMin, Math.min(1, stopFracMax));
        const preRaw = j.preWalkChat;
        const preWalkChat =
            typeof preRaw === 'string' && preRaw.trim() ? preRaw.trim() : null;
        return {
            loop: j.loop !== false,
            arriveXZ: Math.max(0.6, Number(j.arriveXZ) || fallback.arriveXZ),
            maxMs: Math.max(20_000, Number(j.maxMs) || fallback.maxMs),
            stopFracMin,
            stopFracMax,
            lookAlignRad: Math.max(0.03, Number(j.lookAlignRad) || fallback.lookAlignRad),
            lookMaxMs: Math.max(1500, Number(j.lookMaxMs) || fallback.lookMaxMs),
            preWalkChat,
            preWalkChatWaitMs: Math.max(
                500,
                Number(j.preWalkChatWaitMs) || fallback.preWalkChatWaitMs,
            ),
            spawnOnStuck: j.spawnOnStuck !== false,
            spawnWaitMs: Math.max(800, Number(j.spawnWaitMs) || fallback.spawnWaitMs),
            points,
            filePath,
            missing: false,
        };
    } catch (err) {
        return { ...fallback, filePath, missing: true, error: String(err?.message || err) };
    }
}

function clearMoveControls(bot) {
    if (!bot?.setControlState) return;
    for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
        try {
            bot.setControlState(key, false);
        } catch {
            /* ignore */
        }
    }
    try {
        bot.refreshPlayerInput?.();
    } catch {
        /* ignore */
    }
}

/**
 * Индекс ближайшей точки; если уже «на» ней — стартуем с неё (идём к следующей).
 */
export function nearestPointIndex(points, x, z, arriveXZ) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
        const d = xzDist(x, z, points[i].x, points[i].z);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    return { index: best, dist: bestD, onPoint: bestD <= arriveXZ };
}

/**
 * Аккуратный поворот головы к цели (GCD-шаги, как старый осмотр), без WASD.
 * Держим свой yaw — entity.yaw на FT отстаёт.
 */
export async function lookTowardPoint(bot, target, {
    shouldAbort = null,
    alignRad = 0.09,
    maxMs = 5500,
    log = null,
} = {}) {
    if (!bot?.entity) return 'gone';

    const deadline = Date.now() + maxMs;
    let yaw = bot.entity.yaw;
    let pitch = bot.entity.pitch;
    const startYaw = yaw;

    while (Date.now() < deadline) {
        if (typeof shouldAbort === 'function' && shouldAbort()) return 'abort';
        if (!bot?.entity) return 'gone';

        const want = yawTo(bot.entity.position.x, bot.entity.position.z, target.x, target.z);
        let err = normalizeAngle(want - yaw);
        if (Math.abs(err) <= alignRad) {
            try {
                await bot.look(yaw, pitch, true);
            } catch {
                /* ignore */
            }
            const turned = Math.abs(normalizeAngle(yaw - startYaw)) * (180 / Math.PI);
            log?.(
                `walk → look ok Δyaw~${turned.toFixed(0)}° → (${target.x}, ${target.z})`,
            );
            return 'ok';
        }

        // темп как у старого lookSegment: медленно / обычно / чуть быстрее
        const pace = Math.random();
        let yawUnitsMin;
        let yawUnitsMax;
        let steps;
        if (pace < 0.3) {
            yawUnitsMin = 1;
            yawUnitsMax = 3;
            steps = rndInt(6, 14);
        } else if (pace < 0.8) {
            yawUnitsMin = 2;
            yawUnitsMax = 5;
            steps = rndInt(5, 12);
        } else {
            yawUnitsMin = 3;
            yawUnitsMax = 7;
            steps = rndInt(4, 9);
        }

        const dir = err >= 0 ? 1 : -1;
        for (let i = 0; i < steps; i++) {
            if (Date.now() >= deadline) break;
            if (typeof shouldAbort === 'function' && shouldAbort()) return 'abort';
            if (!bot?.entity) return 'gone';

            const remain = normalizeAngle(
                yawTo(bot.entity.position.x, bot.entity.position.z, target.x, target.z) - yaw,
            );
            if (Math.abs(remain) <= alignRad) break;

            const units = rndInt(yawUnitsMin, yawUnitsMax);
            const step = Math.min(Math.abs(remain), units * LOOK_GCD_STEP);
            yaw = normalizeAngle(yaw + dir * step);

            if (Math.random() < 0.22) {
                const pitchUnits = rndInt(1, 3);
                pitch += (Math.random() < 0.5 ? -1 : 1) * pitchUnits * LOOK_GCD_STEP;
                pitch = Math.max(-0.35, Math.min(0.12, pitch));
            } else {
                // слегка к «ходьбе»: чуть вниз
                pitch = pitch * 0.85 + (-0.16) * 0.15;
            }

            try {
                await bot.look(yaw, pitch, true);
            } catch {
                /* ignore */
            }
        }

        if (Math.random() < 0.8) {
            await sleep(rndInt(LOOK_SEGMENT_PAUSE_MIN_MS, LOOK_SEGMENT_PAUSE_MAX_MS));
        }
    }

    log?.(`walk → look timeout → (${target.x}, ${target.z})`);
    return 'timeout';
}

/**
 * Прямая до точки: только forward (+sprint на длинных), лёгкая подстройка yaw.
 */
async function walkStraightToPoint(bot, target, {
    arriveXZ,
    shouldAbort,
    deadline,
    log,
    clientYaw,
}) {
    let lastX = bot.entity?.position?.x;
    let lastZ = bot.entity?.position?.z;
    let lastMoveAt = Date.now();
    let yaw = clientYaw ?? bot.entity?.yaw ?? 0;
    let pitch = bot.entity?.pitch ?? -0.16;

    while (Date.now() < deadline) {
        if (typeof shouldAbort === 'function' && shouldAbort()) {
            clearMoveControls(bot);
            return { status: 'abort', yaw };
        }
        if (!bot?.entity) {
            clearMoveControls(bot);
            return { status: 'gone', yaw };
        }

        const { x, z } = bot.entity.position;
        const dist = xzDist(x, z, target.x, target.z);
        if (dist <= arriveXZ) {
            clearMoveControls(bot);
            return { status: 'ok', yaw };
        }

        const moved = lastX != null ? xzDist(x, z, lastX, lastZ) : 0;
        if (moved > 0.08) {
            lastX = x;
            lastZ = z;
            lastMoveAt = Date.now();
        } else if (Date.now() - lastMoveAt > 5000) {
            clearMoveControls(bot);
            log?.(
                `walk → stuck ~(${x.toFixed(1)},${bot.entity.position.y.toFixed(1)},${z.toFixed(1)})`
                + ` → (${target.x}, ${target.z})`,
            );
            return { status: 'stuck', yaw };
        }

        const want = yawTo(x, z, target.x, target.z);
        let err = normalizeAngle(want - yaw);
        // лёгкая коррекция на ходу (не полный разворот)
        const maxStep = 2.2 * (TICK_MS / 1000);
        if (Math.abs(err) > maxStep) err = Math.sign(err) * maxStep;
        yaw = normalizeAngle(yaw + err);
        pitch = Math.max(-0.4, Math.min(0.1, -0.17 + (Math.random() * 2 - 1) * 0.03));
        try {
            await bot.look(yaw, pitch, true);
        } catch {
            /* ignore */
        }

        try {
            bot.setControlState('forward', true);
            bot.setControlState('sprint', dist > 7);
            bot.refreshPlayerInput?.();
        } catch {
            /* ignore */
        }

        await sleep(TICK_MS);
    }

    clearMoveControls(bot);
    return { status: 'timeout', yaw };
}

/**
 * Одна нога: look → прямая.
 */
async function walkOneLeg(bot, target, opts) {
    const look = await lookTowardPoint(bot, target, {
        shouldAbort: opts.shouldAbort,
        alignRad: opts.lookAlignRad,
        maxMs: opts.lookMaxMs,
        log: opts.log,
    });
    if (look !== 'ok') return look;

    // короткая пауза после поворота — как человек отпустил мышь
    await sleep(rndInt(80, 220));
    if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) return 'abort';

    const yaw = bot.entity?.yaw;
    const res = await walkStraightToPoint(bot, target, {
        arriveXZ: opts.arriveXZ,
        shouldAbort: opts.shouldAbort,
        deadline: opts.deadline,
        log: opts.log,
        clientYaw: yaw,
    });
    return res.status;
}

/**
 * Цепочка целей: вершины до стопа + финальная точка на 25–50% дуги.
 * @returns {{ x: number, y: number, z: number }[]}
 */
function buildLegTargets(points, fromIdx, stop, loop) {
    const targets = [];
    const n = points.length;
    let i = fromIdx;
    const maxHops = loop ? n + 1 : n;
    for (let hop = 0; hop < maxHops; hop++) {
        const j = (i + 1) % n;
        if (!loop && j === 0 && i === n - 1) break;
        const next = points[j];
        const stopOnThisEdge =
            stop.endIdx === j
            && xzDist(stop.x, stop.z, next.x, next.z) > 0.35;
        if (stopOnThisEdge) {
            targets.push({ x: stop.x, y: stop.y, z: stop.z });
            break;
        }
        targets.push(next);
        i = j;
        if (j === stop.endIdx && xzDist(stop.x, stop.z, next.x, next.z) <= 0.35) {
            break;
        }
        // стоп почти на вершине j
        if (
            stop.endIdx === j
            && xzDist(stop.x, stop.z, next.x, next.z) <= 0.35
        ) {
            break;
        }
    }
    if (!targets.length) {
        targets.push({ x: stop.x, y: stop.y, z: stop.z });
    }
    return targets;
}

/**
 * Ловушка у невидимого барьера плазы an502 (z≈21, высокая y).
 */
export function isPlazaBarrierTrap(pos) {
    if (!pos) return false;
    const z = Number(pos.z);
    const y = Number(pos.y);
    if (![z, y].every(Number.isFinite)) return false;
    return z >= 19.5 && z <= 23.5 && y >= 87;
}

async function chatSpawnRecover(bot, {
    shouldAbort = null,
    waitMs = 3500,
    log = null,
    reason = 'stuck',
} = {}) {
    clearMoveControls(bot);
    log?.(`walk → /spawn (${reason})`);
    try {
        bot.chat('/spawn');
    } catch {
        /* ignore */
    }
    await sleep(waitMs);
    if (typeof shouldAbort === 'function' && shouldAbort()) return 'abort';
    if (!bot?.entity) return 'gone';
    const p = bot.entity.position;
    log?.(
        `walk → после spawn ~(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`,
    );
    return 'ok';
}

/**
 * Прогулка: look→прямая по вейпоинтам до случайной точки на 25–50% длины маршрута.
 * stuck / ловушка z≈21 → один /spawn за прогулку, затем продолжаем с ближайшей точки.
 * @returns {Promise<{ ok: boolean, reason: string, stop?: object, legs?: number }>}
 */
export async function walkRandomRouteStop(bot, {
    shouldAbort = null,
    log = null,
    routePath = WALK_ROUTE_PATH,
    rng = Math.random,
} = {}) {
    const logFn = typeof log === 'function' ? log : null;
    const route = loadWalkRoute(routePath);
    if (route.missing || route.points.length < 2) {
        logFn?.(`walk → нет маршрута (${route.error || routePath})`);
        return { ok: false, reason: 'no_route' };
    }

    const pts = route.points;
    if (!bot?.entity) return { ok: false, reason: 'gone' };

    let spawnUsed = false;
    const maybeSpawn = async (reason) => {
        if (!route.spawnOnStuck || spawnUsed) return 'skip';
        spawnUsed = true;
        return chatSpawnRecover(bot, {
            shouldAbort,
            waitMs: route.spawnWaitMs,
            log: logFn,
            reason,
        });
    };

    if (route.preWalkChat) {
        logFn?.(`walk → preChat ${route.preWalkChat}`);
        try {
            bot.chat(route.preWalkChat);
        } catch {
            /* ignore */
        }
        await sleep(route.preWalkChatWaitMs);
        if (typeof shouldAbort === 'function' && shouldAbort()) {
            return { ok: false, reason: 'abort' };
        }
        if (!bot?.entity) return { ok: false, reason: 'gone' };
    } else if (isPlazaBarrierTrap(bot.entity.position)) {
        const r = await maybeSpawn('barrier_trap');
        if (r === 'abort') return { ok: false, reason: 'abort' };
        if (r === 'gone') return { ok: false, reason: 'gone' };
    }

    const total = routeTotalLength(pts, route.loop);
    if (total < 2) return { ok: false, reason: 'route_too_short' };

    const frac =
        route.stopFracMin + rng() * (route.stopFracMax - route.stopFracMin);
    const stopDist = total * frac;

    const buildTargets = () => {
        const { x, z } = bot.entity.position;
        const near = nearestPointIndex(pts, x, z, route.arriveXZ);
        const fromIdx = near.index;
        const stop = pointAlongRoute(pts, fromIdx, stopDist, route.loop);
        if (!stop) return { targets: [], stop: null, fromIdx, near };
        const targets = [];
        if (!near.onPoint) targets.push(pts[fromIdx]);
        targets.push(...buildLegTargets(pts, fromIdx, stop, route.loop));
        return { targets, stop, fromIdx, near };
    };

    let { targets, stop, fromIdx, near } = buildTargets();
    if (!stop || !targets.length) return { ok: false, reason: 'bad_stop' };

    logFn?.(
        `walk → ${Math.round(frac * 100)}% вдоль (${stopDist.toFixed(0)}/${total.toFixed(0)}м)`
        + ` from#${fromIdx} → stop (${stop.x.toFixed(1)}, ${stop.z.toFixed(1)})`
        + ` legs=${targets.length}`
        + (near.onPoint ? ' on_point' : ''),
    );

    const deadline = Date.now() + route.maxMs;
    const opts = {
        arriveXZ: route.arriveXZ,
        lookAlignRad: route.lookAlignRad,
        lookMaxMs: route.lookMaxMs,
        shouldAbort,
        deadline,
        log: logFn,
    };

    let lastStop = stop;
    let done = 0;
    let stuckStreak = 0;

    try {
        for (let leg = 0; leg < targets.length; leg++) {
            if (typeof shouldAbort === 'function' && shouldAbort()) {
                return { ok: false, reason: 'abort', stop: lastStop, legs: done };
            }
            if (Date.now() >= deadline) {
                return { ok: false, reason: 'timeout', stop: lastStop, legs: done };
            }

            const target = targets[leg];
            lastStop = target;
            logFn?.(
                `walk → leg ${leg + 1}/${targets.length}: → (${target.x.toFixed(1)}, ${target.y.toFixed(0)}, ${target.z.toFixed(1)})`,
            );

            const res = await walkOneLeg(bot, target, opts);
            if (res === 'abort') return { ok: false, reason: 'abort', stop: lastStop, legs: done };
            if (res === 'gone') return { ok: false, reason: 'gone', stop: lastStop, legs: done };
            if (res === 'timeout') return { ok: false, reason: 'timeout', stop: lastStop, legs: done };
            if (res === 'stuck') {
                stuckStreak++;
                const trap = bot.entity && isPlazaBarrierTrap(bot.entity.position);
                if (stuckStreak >= 1 && (trap || stuckStreak >= 2)) {
                    const sr = await maybeSpawn(trap ? 'stuck_barrier' : 'stuck');
                    if (sr === 'abort') return { ok: false, reason: 'abort', stop: lastStop, legs: done };
                    if (sr === 'gone') return { ok: false, reason: 'gone', stop: lastStop, legs: done };
                    if (sr === 'ok') {
                        // после spawn — новый кусок маршрута от спавна
                        const rebuilt = buildTargets();
                        if (rebuilt.stop && rebuilt.targets.length) {
                            targets = rebuilt.targets;
                            stop = rebuilt.stop;
                            lastStop = stop;
                            leg = -1; // for-loop ++ → 0
                            stuckStreak = 0;
                            logFn?.(
                                `walk → resume after spawn legs=${targets.length} `
                                + `stop (${stop.x.toFixed(1)}, ${stop.z.toFixed(1)})`,
                            );
                        }
                        continue;
                    }
                }
                continue;
            }
            stuckStreak = 0;
            done++;
        }

        if (done <= 0) {
            logFn?.(`walk → fail all stuck (last ${lastStop.x.toFixed(1)}, ${lastStop.z.toFixed(1)})`);
            return { ok: false, reason: 'all_stuck', stop: lastStop, legs: 0 };
        }

        logFn?.(`walk → arrived (${lastStop.x.toFixed(1)}, ${lastStop.z.toFixed(1)}) legs=${done}`);
        return { ok: true, reason: 'ok', stop: lastStop, legs: done };
    } finally {
        clearMoveControls(bot);
    }
}
