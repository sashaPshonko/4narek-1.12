/**
 * Прогулка по полилинии (без pathfinder).
 * Точки — walk-route.json в корне репо (удобно менять при смене спавна).
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

const TICK_MS = 50;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function normalizeAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}

function xzDist(ax, az, bx, bz) {
    const dx = ax - bx;
    const dz = az - bz;
    return Math.hypot(dx, dz);
}

function yawTo(fromX, fromZ, toX, toZ) {
    // mineflayer: yaw 0 = +Z, увеличивается против часовой к −X (как MC)
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

/** Читает JSON каждый вызов — правки точек без рестарта воркера. */
export function loadWalkRoute(filePath = WALK_ROUTE_PATH) {
    const fallback = {
        loop: true,
        arriveXZ: 1.35,
        maxMs: 120_000,
        maxYawRadPerSec: 2.4,
        points: [],
    };
    if (!existsSync(filePath)) {
        return { ...fallback, filePath, missing: true };
    }
    try {
        const j = JSON.parse(readFileSync(filePath, 'utf8'));
        const points = parseRoutePoints(j.points);
        return {
            loop: j.loop !== false,
            arriveXZ: Math.max(0.6, Number(j.arriveXZ) || fallback.arriveXZ),
            maxMs: Math.max(15_000, Number(j.maxMs) || fallback.maxMs),
            maxYawRadPerSec: Math.max(0.8, Number(j.maxYawRadPerSec) || fallback.maxYawRadPerSec),
            points,
            filePath,
            missing: false,
        };
    } catch (err) {
        return { ...fallback, filePath, missing: true, error: String(err?.message || err) };
    }
}

/**
 * Геометрия замкнутого/разомкнутого пути.
 * @param {{ x: number, y: number, z: number }[]} points
 * @param {boolean} loop
 */
export function buildRouteGeometry(points, loop = true) {
    const pts = points.slice();
    if (pts.length < 2) {
        return { points: pts, segments: [], totalLength: 0 };
    }
    const segments = [];
    const n = pts.length;
    const edgeCount = loop ? n : n - 1;
    let acc = 0;
    for (let i = 0; i < edgeCount; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const len = xzDist(a.x, a.z, b.x, b.z);
        segments.push({
            i,
            a,
            b,
            len,
            startS: acc,
            endS: acc + len,
        });
        acc += len;
    }
    return { points: pts, segments, totalLength: acc };
}

/** Точка на длине дуги s ∈ [0, total]. */
export function pointAtArcLength(geom, s) {
    const { segments, totalLength, points } = geom;
    if (!segments.length) return points[0] || { x: 0, y: 90, z: 0 };
    let t = s;
    if (totalLength > 0) {
        t = ((t % totalLength) + totalLength) % totalLength;
    }
    for (const seg of segments) {
        if (t <= seg.endS + 1e-9) {
            const u = seg.len > 1e-6 ? (t - seg.startS) / seg.len : 0;
            const v = Math.max(0, Math.min(1, u));
            return {
                x: seg.a.x + (seg.b.x - seg.a.x) * v,
                y: seg.a.y + (seg.b.y - seg.a.y) * v,
                z: seg.a.z + (seg.b.z - seg.a.z) * v,
                segIndex: seg.i,
                s: t,
            };
        }
    }
    const last = points[points.length - 1];
    return { ...last, segIndex: segments.length - 1, s: totalLength };
}

export function pickRandomStopOnRoute(geom, rng = Math.random) {
    if (!geom.totalLength) {
        const p = geom.points[0] || { x: 0, y: 90, z: 0 };
        return { ...p, segIndex: 0, s: 0 };
    }
    // не совсем на вершинах — небольшой отступ от 0/конца
    const pad = Math.min(0.35, geom.totalLength * 0.02);
    const span = Math.max(0, geom.totalLength - 2 * pad);
    const s = pad + rng() * span;
    return pointAtArcLength(geom, s);
}

/**
 * Цепочка вейпоинтов: сначала первая точка маршрута, потом вершины до сегмента стопа, потом стоп.
 */
export function buildWaypointChain(geom, stop) {
    const pts = geom.points;
    if (!pts.length) return [];
    const chain = [{ ...pts[0], kind: 'route_start' }];
    const segIndex = Number.isFinite(stop.segIndex) ? stop.segIndex : 0;
    for (let i = 1; i <= segIndex; i++) {
        chain.push({ ...pts[i % pts.length], kind: 'vertex' });
    }
    const last = chain[chain.length - 1];
    if (!last || xzDist(last.x, last.z, stop.x, stop.z) > 0.15) {
        chain.push({ x: stop.x, y: stop.y, z: stop.z, kind: 'stop' });
    } else {
        last.kind = 'stop';
    }
    return chain;
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
}

/**
 * Плавный look к цели (XZ), без force-snap: сами крутим yaw с лимитом °/с.
 * @returns {Promise<number>} текущая ошибка yaw (рад)
 */
async function stepLookToward(bot, targetX, targetZ, maxYawRadPerSec, dtSec) {
    if (!bot?.entity) return Math.PI;
    const yawWant = yawTo(bot.entity.position.x, bot.entity.position.z, targetX, targetZ);
    const yawNow = bot.entity.yaw;
    let err = normalizeAngle(yawWant - yawNow);
    const maxStep = Math.max(0.02, maxYawRadPerSec * dtSec);
    if (Math.abs(err) > maxStep) {
        err = Math.sign(err) * maxStep;
    }
    const yawNext = yawNow + err;
    // лёгкий наклон вниз + микроджиттер — как при ходьбе в клиенте
    const pitchBase = -0.18 + (Math.random() * 2 - 1) * 0.04;
    const pitch = Math.max(-0.45, Math.min(0.12, pitchBase));
    try {
        // true: ставим уже сглаженный yaw сами (не двойная интерполяция mineflayer)
        await bot.look(yawNext, pitch, true);
    } catch {
        /* ignore */
    }
    return normalizeAngle(yawWant - yawNext);
}

/**
 * Идти к одной точке по прямой (ступеньки ок, jump не жмём).
 */
async function walkToPoint(bot, target, opts) {
    const {
        arriveXZ,
        maxYawRadPerSec,
        shouldAbort,
        deadline,
        log,
    } = opts;

    let lastX = bot.entity?.position?.x;
    let lastZ = bot.entity?.position?.z;
    let lastMoveAt = Date.now();

    while (Date.now() < deadline) {
        if (typeof shouldAbort === 'function' && shouldAbort()) return 'abort';
        if (!bot?.entity) return 'gone';

        const { x, z } = bot.entity.position;
        const dist = xzDist(x, z, target.x, target.z);
        if (dist <= arriveXZ) {
            clearMoveControls(bot);
            return 'ok';
        }

        const moved = lastX != null ? xzDist(x, z, lastX, lastZ) : 0;
        if (moved > 0.08) {
            lastX = x;
            lastZ = z;
            lastMoveAt = Date.now();
        } else if (Date.now() - lastMoveAt > 4500) {
            clearMoveControls(bot);
            log?.(`walk → stuck ~(${x.toFixed(1)},${z.toFixed(1)}) → (${target.x},${target.z})`);
            return 'stuck';
        }

        const yawErr = await stepLookToward(bot, target.x, target.z, maxYawRadPerSec, TICK_MS / 1000);
        // пока сильно не довернули — только смотрим (ваниль: не бежим боком)
        if (Math.abs(yawErr) > 0.55) {
            try {
                bot.setControlState('forward', false);
                bot.setControlState('sprint', false);
            } catch {
                /* ignore */
            }
        } else {
            try {
                bot.setControlState('forward', true);
                // спринт только на длинных прямых
                bot.setControlState('sprint', dist > 6 && Math.abs(yawErr) < 0.25);
            } catch {
                /* ignore */
            }
        }

        await sleep(TICK_MS);
    }
    clearMoveControls(bot);
    return 'timeout';
}

/**
 * Прогулка: спавн → первая точка маршрута → по рёбрам до случайной точки на пути.
 * @returns {Promise<{ ok: boolean, reason: string, stop?: object }>}
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

    const geom = buildRouteGeometry(route.points, route.loop);
    if (geom.totalLength < 1) {
        return { ok: false, reason: 'route_too_short' };
    }

    const stop = pickRandomStopOnRoute(geom, rng);
    const chain = buildWaypointChain(geom, stop);
    logFn?.(
        `walk → stop s=${stop.s.toFixed(1)}/${geom.totalLength.toFixed(1)} `
        + `(${stop.x.toFixed(1)}, ${stop.z.toFixed(1)}) waypoints=${chain.length}`,
    );

    const deadline = Date.now() + route.maxMs;
    const opts = {
        arriveXZ: route.arriveXZ,
        maxYawRadPerSec: route.maxYawRadPerSec,
        shouldAbort,
        deadline,
        log: logFn,
    };

    try {
        for (const wp of chain) {
            if (typeof shouldAbort === 'function' && shouldAbort()) {
                return { ok: false, reason: 'abort', stop };
            }
            const res = await walkToPoint(bot, wp, opts);
            if (res === 'abort') return { ok: false, reason: 'abort', stop };
            if (res === 'gone') return { ok: false, reason: 'gone', stop };
            if (res === 'timeout') return { ok: false, reason: 'timeout', stop };
            if (res === 'stuck') {
                // не прыгаем — пропускаем точку, пробуем следующую
                continue;
            }
        }
        logFn?.(`walk → arrived (${stop.x.toFixed(1)}, ${stop.z.toFixed(1)})`);
        return { ok: true, reason: 'ok', stop };
    } finally {
        clearMoveControls(bot);
    }
}
