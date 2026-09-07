/**
 * Прогулка по полилинии (без pathfinder).
 * Точки/кулдаун/доля пути — walk-route.json (читается перед каждой прогулкой).
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const ORCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WALK_ROUTE_PATH = join(ORCH_ROOT, 'walk-route.json');

const TICK_MS = 50;

/** Дефолты, если в JSON нет полей. */
export const WALK_DEFAULTS = {
    loop: true,
    arriveXZ: 1.35,
    maxMs: 90_000,
    maxYawRadPerSec: 2.4,
    /** Проходить от четверти до половины длины маршрута. */
    minFrac: 0.25,
    maxFrac: 0.5,
    /** Реже: ~8–12 мин + иногда skip. */
    cooldownBaseMs: 480_000,
    cooldownJitterMs: 240_000,
    skipBps: 2800,
    startupDelayMaxMs: 180_000,
};

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function hash32(str) {
    let h = 2166136261;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
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

function numOr(v, d) {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
}

/** Читает JSON каждый вызов — правки без рестарта воркера. */
export function loadWalkRoute(filePath = WALK_ROUTE_PATH) {
    const d = WALK_DEFAULTS;
    const base = {
        ...d,
        points: [],
        filePath,
        missing: true,
    };
    if (!existsSync(filePath)) return base;
    try {
        const j = JSON.parse(readFileSync(filePath, 'utf8'));
        const points = parseRoutePoints(j.points);
        let minFrac = Math.max(0.05, numOr(j.minFrac, d.minFrac));
        let maxFrac = Math.max(minFrac, numOr(j.maxFrac, d.maxFrac));
        if (maxFrac > 1) maxFrac = 1;
        return {
            loop: j.loop !== false,
            arriveXZ: Math.max(0.6, numOr(j.arriveXZ, d.arriveXZ)),
            maxMs: Math.max(15_000, numOr(j.maxMs, d.maxMs)),
            maxYawRadPerSec: Math.max(0.8, numOr(j.maxYawRadPerSec, d.maxYawRadPerSec)),
            minFrac,
            maxFrac,
            cooldownBaseMs: Math.max(60_000, numOr(j.cooldownBaseMs, d.cooldownBaseMs)),
            cooldownJitterMs: Math.max(0, numOr(j.cooldownJitterMs, d.cooldownJitterMs)),
            skipBps: Math.max(0, Math.min(9000, numOr(j.skipBps, d.skipBps))),
            startupDelayMaxMs: Math.max(0, numOr(j.startupDelayMaxMs, d.startupDelayMaxMs)),
            points,
            filePath,
            missing: false,
        };
    } catch (err) {
        return { ...base, error: String(err?.message || err) };
    }
}

export function walkCooldownMs(username, route = null) {
    const r = route || loadWalkRoute();
    return r.cooldownBaseMs + (hash32(username) % Math.max(1, r.cooldownJitterMs || 1));
}

export function walkStartupDelayMs(username, route = null) {
    const r = route || loadWalkRoute();
    const max = r.startupDelayMaxMs || 0;
    if (max <= 0) return 0;
    return hash32(`${username}:walkStart`) % max;
}

/** Можно ли в этот sellItems-цикл идти гулять. */
export function shouldAttemptWalk(username, lastWalkTime, workerStartTime, nowMs = Date.now()) {
    const r = loadWalkRoute();
    if (!lastWalkTime) {
        if (nowMs - workerStartTime < walkStartupDelayMs(username, r)) return false;
    } else if (nowMs - lastWalkTime < walkCooldownMs(username, r)) {
        return false;
    }
    if (lastWalkTime && r.skipBps > 0) {
        const minute = Math.floor(nowMs / 60_000);
        if (hash32(`${username}:walkSkip:${minute}`) % 10_000 < r.skipBps) return false;
    }
    return true;
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

/**
 * Стоп через [minFrac..maxFrac] длины маршрута от fromS (обычно 0 = первая точка).
 */
export function pickStopAlongRoute(geom, {
    minFrac = WALK_DEFAULTS.minFrac,
    maxFrac = WALK_DEFAULTS.maxFrac,
    fromS = 0,
    rng = Math.random,
} = {}) {
    if (!geom.totalLength) {
        const p = geom.points[0] || { x: 0, y: 90, z: 0 };
        return { ...p, segIndex: 0, s: 0, walkDist: 0, walkFrac: 0 };
    }
    const lo = Math.min(minFrac, maxFrac);
    const hi = Math.max(minFrac, maxFrac);
    const frac = lo + rng() * (hi - lo);
    const walkDist = frac * geom.totalLength;
    const stop = pointAtArcLength(geom, fromS + walkDist);
    return { ...stop, walkDist, walkFrac: frac };
}

/** @deprecated alias */
export function pickRandomStopOnRoute(geom, rng = Math.random) {
    return pickStopAlongRoute(geom, { rng });
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
    const pitchBase = -0.18 + (Math.random() * 2 - 1) * 0.04;
    const pitch = Math.max(-0.45, Math.min(0.12, pitchBase));
    try {
        await bot.look(yawNext, pitch, true);
    } catch {
        /* ignore */
    }
    return normalizeAngle(yawWant - yawNext);
}

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
 * Прогулка: спавн → первая точка → по рёбрам на ¼–½ длины маршрута.
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

    const stop = pickStopAlongRoute(geom, {
        minFrac: route.minFrac,
        maxFrac: route.maxFrac,
        fromS: 0,
        rng,
    });
    const chain = buildWaypointChain(geom, stop);
    logFn?.(
        `walk → ${(stop.walkFrac * 100).toFixed(0)}% пути (${stop.walkDist.toFixed(0)}/${geom.totalLength.toFixed(0)}м) `
        + `→ (${stop.x.toFixed(1)}, ${stop.z.toFixed(1)}) wp=${chain.length}`,
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
            if (res === 'stuck') continue;
        }
        logFn?.(`walk → arrived (${stop.x.toFixed(1)}, ${stop.z.toFixed(1)})`);
        return { ok: true, reason: 'ok', stop };
    } finally {
        clearMoveControls(bot);
    }
}
