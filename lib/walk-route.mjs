/**
 * Прогулка по полилинии (без pathfinder).
 * Точки/кулдаун/доля пути — walk-route.json (читается перед каждой прогулкой).
 *
 * Вход: ближайшая точка на треке (не обязательно (0,0)).
 * Стоп: +[minFrac..maxFrac] длины вдоль линии.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import Vec3 from 'vec3';

const ORCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WALK_ROUTE_PATH = join(ORCH_ROOT, 'walk-route.json');

const TICK_MS = 50;

export const WALK_DEFAULTS = {
    loop: true,
    arriveXZ: 1.5,
    maxMs: 90_000,
    maxYawRadPerSec: 2.4,
    minFrac: 0.25,
    maxFrac: 0.5,
    cooldownBaseMs: 480_000,
    cooldownJitterMs: 240_000,
    skipBps: 2800,
    startupDelayMaxMs: 180_000,
    /** Если дальше от трека — не пытаемся (варп/чужая зона). */
    maxEntryDist: 48,
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

export function loadWalkRoute(filePath = WALK_ROUTE_PATH) {
    const d = WALK_DEFAULTS;
    const base = { ...d, points: [], filePath, missing: true };
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
            maxEntryDist: Math.max(8, numOr(j.maxEntryDist, d.maxEntryDist)),
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

/** Ближайшая точка на полилинии (проекция на ребро). */
export function nearestOnRoute(geom, x, z) {
    let best = null;
    for (const seg of geom.segments) {
        const dx = seg.b.x - seg.a.x;
        const dz = seg.b.z - seg.a.z;
        const len2 = dx * dx + dz * dz;
        let u = 0;
        if (len2 > 1e-9) {
            u = ((x - seg.a.x) * dx + (z - seg.a.z) * dz) / len2;
            u = Math.max(0, Math.min(1, u));
        }
        const px = seg.a.x + dx * u;
        const pz = seg.a.z + dz * u;
        const py = seg.a.y + (seg.b.y - seg.a.y) * u;
        const dist = xzDist(x, z, px, pz);
        const s = seg.startS + seg.len * u;
        if (!best || dist < best.dist) {
            best = {
                x: px,
                y: py,
                z: pz,
                s,
                dist,
                segIndex: seg.i,
            };
        }
    }
    if (!best && geom.points[0]) {
        const p = geom.points[0];
        best = { ...p, s: 0, dist: xzDist(x, z, p.x, p.z), segIndex: 0 };
    }
    return best;
}

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

/**
 * Вейпоинты вдоль дуги [fromS, fromS+walkDist] (по кругу вперёд).
 * Сначала entry (проекция), потом вершины на пути, потом stop.
 */
export function buildChainAlong(geom, fromS, walkDist) {
    const L = geom.totalLength;
    if (!L || !geom.segments.length) return [];

    const start = ((fromS % L) + L) % L;
    const endUnwrapped = start + Math.max(walkDist, 1);
    const chain = [];

    const entry = pointAtArcLength(geom, start);
    chain.push({ ...entry, kind: 'entry' });

    for (const seg of geom.segments) {
        // вершина = начало ребра; учитываем один «разворот» длины
        for (const base of [0, L]) {
            const v = seg.startS + base;
            if (v > start + 0.4 && v < endUnwrapped - 0.4) {
                chain.push({
                    x: seg.a.x,
                    y: seg.a.y,
                    z: seg.a.z,
                    s: seg.startS,
                    kind: 'vertex',
                    _order: v,
                });
            }
        }
    }
    chain.sort((a, b) => (a._order ?? a.s ?? 0) - (b._order ?? b.s ?? 0));

    const stop = pointAtArcLength(geom, endUnwrapped);
    chain.push({ ...stop, kind: 'stop', _order: endUnwrapped });

    // дедуп близких точек
    const out = [];
    for (const p of chain) {
        const prev = out[out.length - 1];
        if (prev && xzDist(prev.x, prev.z, p.x, p.z) < 0.4) {
            out[out.length - 1] = { ...p, kind: p.kind === 'stop' ? 'stop' : prev.kind };
            continue;
        }
        const { _order, ...rest } = p;
        out.push(rest);
    }
    return out;
}

/** @deprecated */
export function buildWaypointChain(geom, stop) {
    return buildChainAlong(geom, 0, stop.walkDist || stop.s || 0);
}

export function pickRandomStopOnRoute(geom, rng = Math.random) {
    return pickStopAlongRoute(geom, { rng });
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

function blockNameAt(bot, x, y, z) {
    try {
        if (!bot?.blockAt) return '?';
        const b = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
        return b?.name || 'air';
    } catch {
        return '?';
    }
}

/** Ноги / корпус / голова + 1–2 блока впереди по yaw. */
export function describeBlocks(bot) {
    if (!bot?.entity?.position) return 'no-pos';
    const p = bot.entity.position;
    const yaw = bot.entity.yaw ?? 0;
    const fx = -Math.sin(yaw);
    const fz = Math.cos(yaw);
    const y = p.y;
    const feet = blockNameAt(bot, p.x, y - 0.2, p.z);
    const below = blockNameAt(bot, p.x, y - 1.2, p.z);
    const body = blockNameAt(bot, p.x, y + 0.5, p.z);
    const head = blockNameAt(bot, p.x, y + 1.5, p.z);
    const a1 = blockNameAt(bot, p.x + fx * 1.0, y + 0.5, p.z + fz * 1.0);
    const a1f = blockNameAt(bot, p.x + fx * 1.0, y - 0.2, p.z + fz * 1.0);
    const a2 = blockNameAt(bot, p.x + fx * 2.0, y + 0.5, p.z + fz * 2.0);
    const a2f = blockNameAt(bot, p.x + fx * 2.0, y - 0.2, p.z + fz * 2.0);
    return (
        `y=${y.toFixed(1)} below=${below} feet=${feet} body=${body} head=${head} `
        + `| ahead1 body=${a1} feet=${a1f} | ahead2 body=${a2} feet=${a2f}`
    );
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

/** Короткий стрейф при упирании — без jump. */
async function nudgeUnstuck(bot, shouldAbort) {
    clearMoveControls(bot);
    const side = Math.random() < 0.5 ? 'left' : 'right';
    try {
        bot.setControlState('back', true);
        await sleep(280);
        bot.setControlState('back', false);
        if (typeof shouldAbort === 'function' && shouldAbort()) return;
        bot.setControlState(side, true);
        await sleep(350);
        bot.setControlState(side, false);
        bot.setControlState('forward', true);
        await sleep(400);
    } catch {
        /* ignore */
    } finally {
        clearMoveControls(bot);
    }
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
    let nudged = false;

    while (Date.now() < deadline) {
        if (typeof shouldAbort === 'function' && shouldAbort()) return 'abort';
        if (!bot?.entity) return 'gone';

        const { x, y, z } = bot.entity.position;
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
        } else if (Date.now() - lastMoveAt > 4000) {
            const blocks = describeBlocks(bot);
            log?.(
                `walk → stuck ~(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)}) `
                + `→ (${target.x.toFixed(1)},${target.z.toFixed(1)}) ${blocks}`,
            );
            if (!nudged) {
                nudged = true;
                await nudgeUnstuck(bot, shouldAbort);
                lastMoveAt = Date.now();
                lastX = bot.entity?.position?.x;
                lastZ = bot.entity?.position?.z;
                continue;
            }
            clearMoveControls(bot);
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
                bot.setControlState('sprint', dist > 5 && Math.abs(yawErr) < 0.22);
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
 * Прогулка: ближайшая точка трека → вдоль линии на ¼–½ длины.
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
    if (!bot?.entity?.position) {
        return { ok: false, reason: 'no_pos' };
    }

    const geom = buildRouteGeometry(route.points, route.loop);
    if (geom.totalLength < 1) {
        return { ok: false, reason: 'route_too_short' };
    }

    const pos = bot.entity.position;
    const entry = nearestOnRoute(geom, pos.x, pos.z);
    if (!entry) {
        return { ok: false, reason: 'no_entry' };
    }

    logFn?.(
        `walk → pos (${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}) `
        + `entry s=${entry.s.toFixed(1)} dist=${entry.dist.toFixed(1)}м | ${describeBlocks(bot)}`,
    );

    if (entry.dist > route.maxEntryDist) {
        logFn?.(`walk → слишком далеко от трека (${entry.dist.toFixed(1)}>${route.maxEntryDist}) — skip`);
        return { ok: false, reason: 'too_far', entry };
    }

    const stop = pickStopAlongRoute(geom, {
        minFrac: route.minFrac,
        maxFrac: route.maxFrac,
        fromS: entry.s,
        rng,
    });
    const chain = buildChainAlong(geom, entry.s, stop.walkDist);
    logFn?.(
        `walk → ${(stop.walkFrac * 100).toFixed(0)}% вдоль (${stop.walkDist.toFixed(0)}/${geom.totalLength.toFixed(0)}м) `
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

    let reachedStop = false;
    try {
        for (const wp of chain) {
            if (typeof shouldAbort === 'function' && shouldAbort()) {
                return { ok: false, reason: 'abort', stop, entry };
            }
            const res = await walkToPoint(bot, wp, opts);
            if (res === 'abort') return { ok: false, reason: 'abort', stop, entry };
            if (res === 'gone') return { ok: false, reason: 'gone', stop, entry };
            if (res === 'timeout') {
                logFn?.(`walk → timeout | ${describeBlocks(bot)}`);
                return { ok: false, reason: 'timeout', stop, entry };
            }
            if (res === 'stuck') {
                // не скипаем до «arrived» — честный fail
                return { ok: false, reason: 'stuck', stop, entry };
            }
            if (wp.kind === 'stop') reachedStop = true;
        }

        const now = bot.entity?.position;
        const dStop = now ? xzDist(now.x, now.z, stop.x, stop.z) : Infinity;
        if (!reachedStop || dStop > route.arriveXZ * 2.5) {
            logFn?.(
                `walk → fail near-miss d=${dStop.toFixed(1)} `
                + `at (${now?.x.toFixed(1)},${now?.z.toFixed(1)}) | ${describeBlocks(bot)}`,
            );
            return { ok: false, reason: 'miss', stop, entry };
        }
        logFn?.(`walk → arrived (${stop.x.toFixed(1)}, ${stop.z.toFixed(1)}) d=${dStop.toFixed(1)}`);
        return { ok: true, reason: 'ok', stop, entry };
    } finally {
        clearMoveControls(bot);
    }
}
