/**
 * Дамп walkable-сетки вокруг бота + автосборка loop-маршрута в walk-route.json.
 *
 * Триггер: файл spawn-map.dump-request в корне оркестратора
 * (удаляется после успеха). Пишет spawn-map.json + обновляет points в walk-route.json.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { Vec3 } from 'vec3';

const ORCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SPAWN_MAP_PATH = join(ORCH_ROOT, 'spawn-map.json');
export const WALK_ROUTE_PATH = join(ORCH_ROOT, 'walk-route.json');
export const DUMP_REQUEST_PATH = join(ORCH_ROOT, 'spawn-map.dump-request');

const DEFAULTS = {
    radiusXZ: 48,
    yScanDown: 14,
    yScanUp: 8,
    sectorGoals: 7,
    simplifyEpsilon: 1.35,
};

function key(x, z) {
    return `${x},${z}`;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function isAirLike(block) {
    if (!block) return true;
    const n = block.name || '';
    if (n === 'air' || n === 'cave_air' || n === 'void_air') return true;
    if (n === 'light' || n === 'snow') return true;
    if (
        n.endsWith('_carpet')
        || n.includes('flower')
        || n === 'short_grass'
        || n === 'tall_grass'
        || n === 'fern'
        || n === 'large_fern'
        || n === 'torch'
        || n === 'wall_torch'
        || n === 'soul_torch'
        || n === 'beacon'
    ) {
        return true;
    }
    return block.boundingBox === 'empty';
}

function isStandableFloor(block) {
    if (!block || isAirLike(block)) return false;
    const n = block.name || '';
    if (n === 'water' || n === 'lava' || n === 'bubble_column') return false;
    if (n.includes('magma') || n === 'fire' || n === 'soul_fire') return false;
    // листва / лоза — ложные «полы», ломают A*
    if (n.includes('leaves') || n.includes('vine') || n.includes('azalea')) return false;
    return (
        block.boundingBox === 'block'
        || n.includes('slab')
        || n.includes('stairs')
        || n.includes('carpet')
    );
}

/**
 * FunTime an502: на высокой плазе (y≳88) нельзя идти на +Z от z≳19 —
 * невидимый барьер у z≈21. Спуск на юг только по лестнице (y падает <88).
 */
export function plazaBarrierBlocksEdge(fromCell, toCell) {
    if (!fromCell || !toCell) return true;
    const high = fromCell.y >= 88 && toCell.y >= 88;
    if (!high) return false;
    if (fromCell.z >= 19 && toCell.z > fromCell.z) return true;
    return false;
}

function blockAt(bot, x, y, z) {
    try {
        return bot.blockAt(new Vec3(x, y, z));
    } catch {
        return null;
    }
}

/** Пол под (x,z): ноги на y = floorY+1. Предпочитаем слой около preferY. */
function probeStandAt(bot, x, z, preferY) {
    const y0 = Math.floor(preferY);
    const yMin = y0 - DEFAULTS.yScanDown;
    const yMax = y0 + DEFAULTS.yScanUp;
    const candidates = [];
    for (let y = yMax; y >= yMin; y--) {
        const floor = blockAt(bot, x, y, z);
        const feet = blockAt(bot, x, y + 1, z);
        const head = blockAt(bot, x, y + 2, z);
        if (!isStandableFloor(floor)) continue;
        if (!isAirLike(feet) || !isAirLike(head)) continue;
        const feetY = y + 1;
        candidates.push({
            y: feetY,
            floorY: y,
            floor: floor?.name || '?',
            score: Math.abs(feetY - preferY),
        });
    }
    if (!candidates.length) return null;
    // сначала ближайший к preferY в ±2.5, иначе ближайший вообще
    const near = candidates.filter((c) => c.score <= 2.5);
    const pool = near.length ? near : candidates;
    pool.sort((a, b) => a.score - b.score);
    return pool[0];
}

/**
 * @returns {{
 *   origin: {x:number,y:number,z:number},
 *   radiusXZ: number,
 *   cells: Record<string, {x:number,z:number,y:number,floor:string,floorY:number}>,
 *   walkableCount: number,
 *   dumpedAt: string,
 * }}
 */
export function dumpWalkableGrid(bot, {
    radiusXZ = DEFAULTS.radiusXZ,
    preferY = null,
    log = null,
} = {}) {
    if (!bot?.entity) throw new Error('no_entity');
    const ox = Math.floor(bot.entity.position.x);
    const oy = preferY != null ? preferY : bot.entity.position.y;
    const oz = Math.floor(bot.entity.position.z);
    const cells = Object.create(null);
    let walkableCount = 0;
    let scanned = 0;

    for (let dx = -radiusXZ; dx <= radiusXZ; dx++) {
        for (let dz = -radiusXZ; dz <= radiusXZ; dz++) {
            scanned++;
            const x = ox + dx;
            const z = oz + dz;
            const stand = probeStandAt(bot, x, z, oy);
            if (!stand) continue;
            cells[key(x, z)] = {
                x,
                z,
                y: stand.y,
                floorY: stand.floorY,
                floor: stand.floor,
            };
            walkableCount++;
        }
    }

    log?.(
        `spawn-map → dump ${walkableCount}/${scanned} walkable r=${radiusXZ} `
        + `origin=(${ox},${Math.round(oy)},${oz})`,
    );

    return {
        origin: { x: ox, y: oy, z: oz },
        radiusXZ,
        cells,
        walkableCount,
        dumpedAt: new Date().toISOString(),
    };
}

function neighbors4(x, z) {
    return [
        [x + 1, z],
        [x - 1, z],
        [x, z + 1],
        [x, z - 1],
    ];
}

function canStep(a, b) {
    if (!a || !b) return false;
    if (Math.abs(a.y - b.y) > 1.01) return false;
    if (plazaBarrierBlocksEdge(a, b)) return false;
    return true;
}

/** A* → массив {x,y,z} или null. */
export function astarPath(cells, start, goal) {
    const sk = key(start.x, start.z);
    const gk = key(goal.x, goal.z);
    if (!cells[sk] || !cells[gk]) return null;

    const open = new Map();
    const came = new Map();
    const gScore = new Map();
    const fScore = new Map();
    const h = (x, z) => Math.abs(x - goal.x) + Math.abs(z - goal.z);

    open.set(sk, { x: start.x, z: start.z });
    gScore.set(sk, 0);
    fScore.set(sk, h(start.x, start.z));

    while (open.size) {
        let bestK = null;
        let bestF = Infinity;
        for (const k of open.keys()) {
            const f = fScore.get(k) ?? Infinity;
            if (f < bestF) {
                bestF = f;
                bestK = k;
            }
        }
        const cur = open.get(bestK);
        open.delete(bestK);
        if (bestK === gk) {
            const path = [];
            let k = gk;
            while (k) {
                const [x, z] = k.split(',').map(Number);
                path.push({ x, y: cells[k].y, z });
                k = came.get(k);
            }
            path.reverse();
            return path;
        }

        const curCell = cells[bestK];
        for (const [nx, nz] of neighbors4(cur.x, cur.z)) {
            const nk = key(nx, nz);
            const next = cells[nk];
            if (!canStep(curCell, next)) continue;
            const tentative = (gScore.get(bestK) ?? Infinity) + 1;
            if (tentative >= (gScore.get(nk) ?? Infinity)) continue;
            came.set(nk, bestK);
            gScore.set(nk, tentative);
            fScore.set(nk, tentative + h(nx, nz));
            if (!open.has(nk)) open.set(nk, { x: nx, z: nz });
        }
    }
    return null;
}

/** RDP по XZ. */
export function simplifyPath(points, epsilon = DEFAULTS.simplifyEpsilon) {
    if (!points || points.length <= 2) return points ? points.slice() : [];

    function perpDist(p, a, b) {
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const len2 = dx * dx + dz * dz;
        if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.z - a.z);
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
        return Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz));
    }

    function rdp(pts) {
        if (pts.length <= 2) return pts;
        let maxD = 0;
        let idx = 0;
        const a = pts[0];
        const b = pts[pts.length - 1];
        for (let i = 1; i < pts.length - 1; i++) {
            const d = perpDist(pts[i], a, b);
            if (d > maxD) {
                maxD = d;
                idx = i;
            }
        }
        if (maxD > epsilon) {
            const left = rdp(pts.slice(0, idx + 1));
            const right = rdp(pts.slice(idx));
            return left.slice(0, -1).concat(right);
        }
        return [a, b];
    }

    return rdp(points);
}

function pickSectorGoals(cells, start, count) {
    const sk = key(start.x, start.z);
    if (!cells[sk]) return [];

    const comp = new Set();
    const q = [{ x: start.x, z: start.z }];
    comp.add(sk);
    while (q.length) {
        const c = q.shift();
        const cur = cells[key(c.x, c.z)];
        for (const [nx, nz] of neighbors4(c.x, c.z)) {
            const nk = key(nx, nz);
            if (comp.has(nk)) continue;
            if (!canStep(cur, cells[nk])) continue;
            comp.add(nk);
            q.push({ x: nx, z: nz });
        }
    }

    const bySector = Array.from({ length: count }, () => null);
    for (const k of comp) {
        const c = cells[k];
        const dx = c.x - start.x;
        const dz = c.z - start.z;
        const dist = Math.hypot(dx, dz);
        if (dist < 8) continue;
        let ang = Math.atan2(dz, dx);
        if (ang < 0) ang += Math.PI * 2;
        const si = Math.min(count - 1, Math.floor((ang / (Math.PI * 2)) * count));
        const prev = bySector[si];
        if (!prev || dist > prev.dist) {
            bySector[si] = { x: c.x, y: c.y, z: c.z, dist };
        }
    }
    return bySector.filter(Boolean).sort((a, b) => {
        const aa = Math.atan2(a.z - start.z, a.x - start.x);
        const bb = Math.atan2(b.z - start.z, b.x - start.x);
        return aa - bb;
    });
}

export function buildAutoLoop(cells, start, {
    sectorGoals = DEFAULTS.sectorGoals,
    simplifyEpsilon = DEFAULTS.simplifyEpsilon,
    log = null,
} = {}) {
    const goals = pickSectorGoals(cells, start, sectorGoals);
    if (!goals.length) {
        log?.('spawn-map → нет целей для loop');
        return [];
    }

    const waypoints = [{ x: start.x, y: cells[key(start.x, start.z)].y, z: start.z }];
    let from = start;
    for (const g of goals) {
        const seg = astarPath(cells, from, g);
        if (!seg || seg.length < 2) {
            log?.(`spawn-map → нет пути к (${g.x},${g.z})`);
            continue;
        }
        for (let i = 1; i < seg.length; i++) waypoints.push(seg[i]);
        from = g;
    }
    const home = astarPath(cells, from, start);
    if (home && home.length > 1) {
        for (let i = 1; i < home.length; i++) waypoints.push(home[i]);
    }

    const simplified = simplifyPath(waypoints, simplifyEpsilon);
    if (
        simplified.length > 2
        && simplified[0].x === simplified[simplified.length - 1].x
        && simplified[0].z === simplified[simplified.length - 1].z
    ) {
        simplified.pop();
    }

    log?.(
        `spawn-map → loop raw=${waypoints.length} simple=${simplified.length} goals=${goals.length}`,
    );
    return simplified;
}

function writeSpawnMapFile(dump, path = SPAWN_MAP_PATH) {
    const walkable = Object.values(dump.cells).map((c) => [c.x, c.y, c.z, c.floor]);
    const out = {
        dumpedAt: dump.dumpedAt,
        origin: dump.origin,
        radiusXZ: dump.radiusXZ,
        walkableCount: dump.walkableCount,
        walkable,
    };
    writeFileSync(path, `${JSON.stringify(out)}\n`, 'utf8');
}

function mergeWalkRoutePoints(points, path = WALK_ROUTE_PATH) {
    let base = {
        loop: true,
        arriveXZ: 1.25,
        maxMs: 180000,
        stopFracMin: 0.25,
        stopFracMax: 0.5,
        lookAlignRad: 0.09,
        lookMaxMs: 5500,
        preWalkChat: null,
        preWalkChatWaitMs: 7500,
        spawnOnStuck: true,
        spawnWaitMs: 7500,
        spawnPoint: { x: 0, y: 90, z: 0 },
        points: [],
    };
    if (existsSync(path)) {
        try {
            base = { ...base, ...JSON.parse(readFileSync(path, 'utf8')) };
        } catch {
            /* keep */
        }
    }
    base.points = points.map((p) => ({
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        z: Math.round(p.z * 10) / 10,
    }));
    base.autoFromMap = true;
    base.autoAt = new Date().toISOString();
    writeFileSync(path, `${JSON.stringify(base, null, 2)}\n`, 'utf8');
}

/** Загрузка cells из spawn-map.json (с фильтром листвы). */
export function loadCellsFromSpawnMap(path = SPAWN_MAP_PATH) {
    if (!existsSync(path)) return null;
    const j = JSON.parse(readFileSync(path, 'utf8'));
    const cells = Object.create(null);
    for (const row of j.walkable || []) {
        const [x, y, z, floor] = row;
        if (typeof floor === 'string' && (floor.includes('leaves') || floor.includes('vine'))) {
            continue;
        }
        cells[key(x, z)] = { x, z, y, floorY: y - 1, floor: floor || '?' };
    }
    return {
        origin: j.origin,
        radiusXZ: j.radiusXZ,
        cells,
        walkableCount: Object.keys(cells).length,
        dumpedAt: j.dumpedAt,
    };
}

/**
 * Пересобрать walk-route.json из уже сохранённого spawn-map.json (без бота).
 */
export function rebuildWalkRouteFromSavedMap({
    mapPath = SPAWN_MAP_PATH,
    routePath = WALK_ROUTE_PATH,
    start = null,
    log = console.log,
} = {}) {
    const dump = loadCellsFromSpawnMap(mapPath);
    if (!dump || dump.walkableCount < 20) {
        log?.('spawn-map → rebuild: нет карты');
        return null;
    }

    // Спавн = заданная стартовая точка (0,0), не origin дампа (где стоял бот).
    let sx = start?.x;
    let sz = start?.z;
    if (sx == null || sz == null) {
        sx = 0;
        sz = 0;
    }
    if (!dump.cells[key(sx, sz)]) {
        let best = null;
        let bestD = Infinity;
        for (const c of Object.values(dump.cells)) {
            const d = Math.hypot(c.x - sx, c.z - sz);
            if (d < bestD) {
                bestD = d;
                best = c;
            }
        }
        if (!best) return null;
        sx = best.x;
        sz = best.z;
    }

    const loop = buildAutoLoop(dump.cells, { x: sx, z: sz }, { log });
    if (loop.length < 3) {
        log?.('spawn-map → rebuild: loop короткий');
        return null;
    }
    mergeWalkRoutePoints(loop, routePath);
    log?.(`spawn-map → rebuild ok (${loop.length} pts) start=(${sx},${sz})`);
    return loop;
}

/**
 * Если есть spawn-map.dump-request — дамп + автомаршрут.
 * @returns {Promise<boolean>}
 */
export async function maybeDumpSpawnMap(bot, log = console.log) {
    if (!existsSync(DUMP_REQUEST_PATH)) return false;
    if (!bot?.entity || !bot.blockAt) {
        log?.('spawn-map → skip (нет бота/world)');
        return false;
    }

    const logFn = typeof log === 'function' ? log : console.log;
    logFn('spawn-map → dump-request найден, жду чанки…');

    try {
        if (typeof bot.waitForChunksToLoad === 'function') {
            await bot.waitForChunksToLoad();
        } else {
            await sleep(2500);
        }
        await sleep(1500);

        const dump = dumpWalkableGrid(bot, { log: logFn });
        if (dump.walkableCount < 20) {
            logFn(`spawn-map → мало walkable (${dump.walkableCount}), abort`);
            return false;
        }

        writeSpawnMapFile(dump);

        // Маршрут от спавна (0,0), не от позиции бота в момент дампа.
        const start = { x: 0, z: 0 };
        if (!dump.cells[key(start.x, start.z)]) {
            let best = null;
            let bestD = Infinity;
            for (const c of Object.values(dump.cells)) {
                const d = Math.hypot(c.x - start.x, c.z - start.z);
                if (d < bestD) {
                    bestD = d;
                    best = c;
                }
            }
            if (!best) return false;
            start.x = best.x;
            start.z = best.z;
        }

        const loop = buildAutoLoop(dump.cells, start, { log: logFn });
        if (loop.length < 3) {
            logFn('spawn-map → loop слишком короткий');
            return false;
        }

        mergeWalkRoutePoints(loop);
        try {
            unlinkSync(DUMP_REQUEST_PATH);
        } catch {
            /* ignore */
        }
        logFn(`spawn-map → готово: spawn-map.json + walk-route (${loop.length} pts)`);
        return true;
    } catch (err) {
        logFn(`spawn-map → ошибка: ${err?.message || err}`);
        return false;
    }
}
