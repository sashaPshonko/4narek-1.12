/**
 * Карта плоскости /warp shop: большой walkable-дамп → доминирующая высота →
 * случайные A*-маршруты с разводом ботов по секторам.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    dumpWalkableGrid,
    loadCellsFromSpawnMap,
    astarPath,
    simplifyPath,
} from './spawn-map.mjs';

const ORCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SHOP_MAP_PATH = join(ORCH_ROOT, 'shop-map.json');
export const SHOP_DUMP_REQUEST_PATH = join(ORCH_ROOT, 'shop-map.dump-request');

const DEFAULTS = {
    radiusXZ: 72,
    minFlatCells: 400,
    yBand: 1.01,
    maxAgeMs: 12 * 60 * 60 * 1000,
    legsMin: 5,
    legsMax: 9,
    goalDistMin: 18,
    goalDistMax: 48,
    simplifyEpsilon: 1.6,
    sectors: 8,
};

function cellKey(x, z) {
    return `${x},${z}`;
}

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

function neighbors4(x, z) {
    return [
        [x + 1, z],
        [x - 1, z],
        [x, z + 1],
        [x, z - 1],
    ];
}

function canStepFlat(a, b) {
    if (!a || !b) return false;
    return Math.abs(a.y - b.y) <= 1.01;
}

/**
 * Доминирующая высота ног + крупнейшая связная компонента на этой полосе.
 * @returns {{ cells: object, flatY: number, walkableCount: number } | null}
 */
export function extractLargestFlatComponent(cells, { yBand = DEFAULTS.yBand } = {}) {
    const list = Object.values(cells || {});
    if (list.length < 20) return null;

    const yCount = new Map();
    for (const c of list) {
        const y = Math.round(c.y);
        yCount.set(y, (yCount.get(y) || 0) + 1);
    }
    let flatY = list[0].y;
    let bestN = 0;
    for (const [y, n] of yCount) {
        if (n > bestN) {
            bestN = n;
            flatY = y;
        }
    }

    const band = Object.create(null);
    for (const c of list) {
        if (Math.abs(c.y - flatY) <= yBand) {
            band[cellKey(c.x, c.z)] = c;
        }
    }

    // BFS компоненты
    const seen = new Set();
    let bestComp = [];
    for (const startK of Object.keys(band)) {
        if (seen.has(startK)) continue;
        const comp = [];
        const q = [startK];
        seen.add(startK);
        while (q.length) {
            const k = q.shift();
            comp.push(k);
            const cur = band[k];
            for (const [nx, nz] of neighbors4(cur.x, cur.z)) {
                const nk = cellKey(nx, nz);
                if (seen.has(nk) || !band[nk]) continue;
                if (!canStepFlat(cur, band[nk])) continue;
                seen.add(nk);
                q.push(nk);
            }
        }
        if (comp.length > bestComp.length) bestComp = comp;
    }

    if (bestComp.length < 20) return null;
    const out = Object.create(null);
    for (const k of bestComp) out[k] = band[k];
    return {
        cells: out,
        flatY,
        walkableCount: bestComp.length,
    };
}

function writeShopMapFile(dump, flat, path = SHOP_MAP_PATH) {
    const walkable = Object.values(flat.cells).map((c) => [c.x, c.y, c.z, c.floor]);
    const out = {
        dumpedAt: dump.dumpedAt,
        origin: dump.origin,
        radiusXZ: dump.radiusXZ,
        flatY: flat.flatY,
        walkableCount: flat.walkableCount,
        rawWalkableCount: dump.walkableCount,
        walkable,
    };
    writeFileSync(path, `${JSON.stringify(out)}\n`, 'utf8');
    return out;
}

/** Загрузка shop-map.json → cells (уже плоская компонента). */
export function loadShopMap(path = SHOP_MAP_PATH) {
    if (!existsSync(path)) return null;
    try {
        const dump = loadCellsFromSpawnMap(path);
        if (!dump || dump.walkableCount < 20) return null;
        const j = JSON.parse(readFileSync(path, 'utf8'));
        return {
            ...dump,
            flatY: j.flatY ?? dump.origin?.y,
            path,
        };
    } catch {
        return null;
    }
}

function mapIsFresh(map, maxAgeMs) {
    if (!map?.dumpedAt) return false;
    const t = Date.parse(map.dumpedAt);
    if (!Number.isFinite(t)) return false;
    return Date.now() - t < maxAgeMs;
}

/**
 * Дамп большой зоны вокруг бота → фильтр плоскости → shop-map.json.
 */
export async function dumpShopFlatMap(bot, {
    radiusXZ = DEFAULTS.radiusXZ,
    minFlatCells = DEFAULTS.minFlatCells,
    log = null,
    path = SHOP_MAP_PATH,
} = {}) {
    if (!bot?.entity || !bot.blockAt) throw new Error('no_bot');
    const logFn = typeof log === 'function' ? log : null;

    if (typeof bot.waitForChunksToLoad === 'function') {
        try {
            await bot.waitForChunksToLoad();
        } catch {
            /* ignore */
        }
    }
    await sleep(1200);

    logFn?.(`shop-map → dump r=${radiusXZ}…`);
    const dump = dumpWalkableGrid(bot, { radiusXZ, log: logFn });
    const flat = extractLargestFlatComponent(dump.cells);
    if (!flat || flat.walkableCount < minFlatCells) {
        throw new Error(
            `flat_too_small (${flat?.walkableCount || 0}/${minFlatCells}, raw=${dump.walkableCount})`,
        );
    }

    const meta = writeShopMapFile(dump, flat, path);
    logFn?.(
        `shop-map → flatY=${flat.flatY} cells=${flat.walkableCount}`
        + ` raw=${dump.walkableCount} origin=(${dump.origin.x},${dump.origin.z})`,
    );
    return {
        ...loadShopMap(path),
        meta,
    };
}

/**
 * Вернуть свежую карту; при необходимости просканировать мир бота.
 * force / shop-map.dump-request — всегда перескан.
 */
export async function ensureShopFlatMap(bot, {
    radiusXZ = DEFAULTS.radiusXZ,
    minFlatCells = DEFAULTS.minFlatCells,
    maxAgeMs = DEFAULTS.maxAgeMs,
    force = false,
    log = null,
    path = SHOP_MAP_PATH,
} = {}) {
    const wantForce = force || existsSync(SHOP_DUMP_REQUEST_PATH);
    const existing = loadShopMap(path);
    if (!wantForce && existing && mapIsFresh(existing, maxAgeMs)
        && existing.walkableCount >= minFlatCells) {
        log?.(
            `shop-map → cache ok cells=${existing.walkableCount}`
            + ` flatY=${existing.flatY} age`,
        );
        return existing;
    }

    const map = await dumpShopFlatMap(bot, { radiusXZ, minFlatCells, log, path });
    if (existsSync(SHOP_DUMP_REQUEST_PATH)) {
        try {
            unlinkSync(SHOP_DUMP_REQUEST_PATH);
        } catch {
            /* ignore */
        }
    }
    return map;
}

function nearestCell(cells, x, z) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const exact = cells[cellKey(ix, iz)];
    if (exact) return exact;
    let best = null;
    let bestD = Infinity;
    for (const c of Object.values(cells)) {
        const d = Math.hypot(c.x - x, c.z - z);
        if (d < bestD) {
            bestD = d;
            best = c;
        }
    }
    return best;
}

function cellAngle(origin, cell) {
    let ang = Math.atan2(cell.z - origin.z, cell.x - origin.x);
    if (ang < 0) ang += Math.PI * 2;
    return ang;
}

/**
 * Бот уже на плоскости shop-map? (не надо снова /warp shop)
 */
export function isOnShopFlatMap(cells, pos, { maxDist = 4 } = {}) {
    if (!cells || !pos) return false;
    const near = nearestCell(cells, pos.x, pos.z);
    if (!near) return false;
    return Math.hypot(near.x - pos.x, near.z - pos.z) <= maxDist
        && Math.abs((near.y ?? pos.y) - pos.y) <= 2.5;
}

/**
 * Случайный маршрут по всей плоской территории.
 * Ник → свой сектор; ноги чередуют сектора/дальние края, чтобы покрывать площадь,
 * а не крутиться у точки варпа.
 */
export function generateSpreadMapRoute(cells, startPos, {
    username = '',
    legsMin = DEFAULTS.legsMin,
    legsMax = DEFAULTS.legsMax,
    goalDistMin = DEFAULTS.goalDistMin,
    goalDistMax = DEFAULTS.goalDistMax,
    simplifyEpsilon = DEFAULTS.simplifyEpsilon,
    sectors = DEFAULTS.sectors,
    warpOrigin = null,
    rng = Math.random,
    log = null,
} = {}) {
    const start = nearestCell(cells, startPos.x, startPos.z);
    if (!start) return [];

    const all = Object.values(cells);
    if (all.length < 30) return [];

    const centroid = {
        x: all.reduce((s, c) => s + c.x, 0) / all.length,
        z: all.reduce((s, c) => s + c.z, 0) / all.length,
    };
    // точка варпа / центр дампа — от неё уходим в края
    const hub = warpOrigin && Number.isFinite(warpOrigin.x)
        ? { x: warpOrigin.x, z: warpOrigin.z }
        : centroid;

    const preferredSector = hash32(`${username}:shop-sector`) % sectors;
    const nLegs = legsMin + Math.floor(rng() * (Math.max(0, legsMax - legsMin) + 1));

    // радиус территории — цели ближе к краю
    let maxHubR = 1;
    for (const c of all) {
        maxHubR = Math.max(maxHubR, Math.hypot(c.x - hub.x, c.z - hub.z));
    }

    const pickGoal = (from, legIndex) => {
        // чередуем сектора: свой → +3 → +5 → … чтобы гулять по всей карте
        const sector = (preferredSector + legIndex * 3) % sectors;
        const preferDist = goalDistMin + rng() * (goalDistMax - goalDistMin);
        let best = null;
        let bestScore = -Infinity;
        const tries = Math.min(120, all.length);
        for (let t = 0; t < tries; t++) {
            const c = all[Math.floor(rng() * all.length)];
            const dist = Math.hypot(c.x - from.x, c.z - from.z);
            if (dist < goalDistMin * 0.55) continue;
            if (dist > goalDistMax * 1.5) continue;

            const si = Math.min(
                sectors - 1,
                Math.floor((cellAngle(centroid, c) / (Math.PI * 2)) * sectors),
            );
            const sectorDelta = Math.min(
                (si - sector + sectors) % sectors,
                (sector - si + sectors) % sectors,
            );
            const sectorBonus = sectorDelta === 0 ? 28 : (sectorDelta === 1 ? 10 : -8);

            const hubDist = Math.hypot(c.x - hub.x, c.z - hub.z);
            // сильнее тянем к краям территории, не к хабу варпа
            const edgeBonus = (hubDist / maxHubR) * 35;
            const distScore = -Math.abs(dist - preferDist) * 0.35;
            // первая нога — особенно далеко от хаба
            const leaveHub = legIndex === 0 ? hubDist * 0.4 : hubDist * 0.1;

            const score = sectorBonus + edgeBonus + distScore + leaveHub + rng() * 4;
            if (score > bestScore) {
                bestScore = score;
                best = c;
            }
        }
        // fallback: просто дальняя клетка в секторе
        if (!best) {
            for (const c of all) {
                const si = Math.min(
                    sectors - 1,
                    Math.floor((cellAngle(centroid, c) / (Math.PI * 2)) * sectors),
                );
                if (si !== sector) continue;
                const hubDist = Math.hypot(c.x - hub.x, c.z - hub.z);
                const score = hubDist + rng();
                if (score > bestScore) {
                    bestScore = score;
                    best = c;
                }
            }
        }
        return best;
    };

    const waypoints = [{ x: start.x, y: start.y, z: start.z }];
    let from = start;
    let made = 0;
    for (let i = 0; i < nLegs; i++) {
        const goal = pickGoal(from, i);
        if (!goal) break;
        const path = astarPath(cells, from, goal);
        if (!path || path.length < 2) continue;
        for (let j = 1; j < path.length; j++) waypoints.push(path[j]);
        from = goal;
        made += 1;
    }

    const simplified = simplifyPath(waypoints, simplifyEpsilon);
    const end = simplified[simplified.length - 1] || start;
    const leave = Math.hypot(end.x - hub.x, end.z - hub.z);
    log?.(
        `shop-map → route pts=${simplified.length} legs=${made}/${nLegs}`
        + ` sector0=${preferredSector}/${sectors}`
        + ` start=(${start.x},${start.z}) end=(${end.x},${end.z})`
        + ` leaveHub=${leave.toFixed(0)}/${maxHubR.toFixed(0)}`,
    );
    return simplified;
}
