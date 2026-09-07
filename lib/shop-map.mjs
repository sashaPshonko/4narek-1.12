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
    simplifyPath,
} from './spawn-map.mjs';

const ORCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SHOP_MAP_PATH = join(ORCH_ROOT, 'shop-map.json');
export const SHOP_DUMP_REQUEST_PATH = join(ORCH_ROOT, 'shop-map.dump-request');
/** Общая на все воркеры память о непроходимых клетках (прилавки, заборы, чужие боты). */
export const SHOP_BLOCKED_PATH = join(ORCH_ROOT, 'shop-blocked.json');

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
    blockedTtlMs: 3 * 60 * 60 * 1000,
    blockedMaxCells: 8000,
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

/* ── память о препятствиях ─────────────────────────────────────────────── */

/**
 * Клетки, где боты реально застревали. Блок-скан их не видит (прилавки,
 * энтити, невидимые барьеры), поэтому учим карту по факту.
 * @returns {Map<string, { t: number, n: number }>}
 */
export function loadBlockedCells({
    path = SHOP_BLOCKED_PATH,
    ttlMs = DEFAULTS.blockedTtlMs,
    now = Date.now(),
} = {}) {
    const out = new Map();
    if (!existsSync(path)) return out;
    try {
        const j = JSON.parse(readFileSync(path, 'utf8'));
        for (const [k, v] of Object.entries(j.cells || {})) {
            const t = Number(v?.t) || 0;
            if (now - t > ttlMs) continue;
            out.set(k, { t, n: Number(v?.n) || 1 });
        }
    } catch {
        /* карта препятствий не критична */
    }
    return out;
}

/** Слить свежие блокировки с тем, что уже записали другие воркеры. */
export function saveBlockedCells(blocked, {
    path = SHOP_BLOCKED_PATH,
    ttlMs = DEFAULTS.blockedTtlMs,
    maxCells = DEFAULTS.blockedMaxCells,
    now = Date.now(),
} = {}) {
    if (!blocked?.size) return;
    const merged = loadBlockedCells({ path, ttlMs, now });
    for (const [k, v] of blocked) {
        const prev = merged.get(k);
        merged.set(k, {
            t: Math.max(prev?.t || 0, v?.t || now),
            n: (prev?.n || 0) + (v?.n || 1),
        });
    }
    // файл общий на всю ферму — держим только свежее
    let entries = [...merged];
    if (entries.length > maxCells) {
        entries.sort((a, b) => (b[1].t - a[1].t) || (b[1].n - a[1].n));
        entries = entries.slice(0, maxCells);
    }
    const cells = {};
    for (const [k, v] of entries) cells[k] = v;
    try {
        writeFileSync(path, `${JSON.stringify({ savedAt: new Date(now).toISOString(), cells })}\n`, 'utf8');
    } catch {
        /* ignore */
    }
}

/** Клетка, в которую бот упёрся: ~1 блок вперёд по направлению к цели. */
export function obstacleCellAhead(from, target, ahead = 1.3) {
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return { x: Math.floor(from.x), z: Math.floor(from.z) };
    return {
        x: Math.floor(from.x + (dx / len) * ahead),
        z: Math.floor(from.z + (dz / len) * ahead),
    };
}

/**
 * Отметить препятствие так, чтобы A* реально искал другой путь.
 *
 * Одна клетка бесполезна: бот обойдёт её вплотную и упрётся в ту же стену
 * через два блока («ползание вдоль стены»). Поэтому:
 *  1) бьём полосой поперёк направления движения — это и есть стена перед носом;
 *  2) если прошлое касание было на одной линии с новым — достраиваем всю
 *     стену между ними и продлеваем за концы. Два касания = стена известна.
 *
 * @returns {{ cell: {x:number,z:number}, marked: number, wall: boolean }}
 */
export function markObstacle({
    blocked,
    fresh = null,
    from,
    target,
    recent = [],
    repeats = 0,
    maxGap = 16,
    extend = 8,
    now = Date.now(),
}) {
    let marked = 0;
    const mark = (x, z) => {
        const k = cellKey(Math.round(x), Math.round(z));
        if (!blocked.has(k)) {
            blocked.set(k, { t: now, n: 1 });
            marked += 1;
        }
        if (fresh) {
            const prev = fresh.get(k);
            fresh.set(k, { t: now, n: (prev?.n || 0) + 1 });
        }
    };

    const cell = obstacleCellAhead(from, target);
    const dx = target.x - from.x;
    const dz = target.z - from.z;
    const len = Math.hypot(dx, dz) || 1;
    const ux = dx / len;
    const uz = dz / len;
    // полоса поперёк курса, толщиной 2 клетки по ходу движения
    const span = 2 + repeats * 3;
    for (let s = -span; s <= span; s++) {
        for (let d = 0; d <= 1; d++) {
            mark(cell.x - uz * s + ux * d, cell.z + ux * s + uz * d);
        }
    }

    // достраиваем стену по прошлым касаниям на той же линии
    let wall = false;
    for (const prev of recent) {
        const gx = cell.x - prev.x;
        const gz = cell.z - prev.z;
        const gap = Math.hypot(gx, gz);
        if (gap < 2 || gap > maxGap) continue;
        // касания должны лежать вдоль одной стены (по x или по z)
        if (Math.abs(gx) > 1.5 && Math.abs(gz) > 1.5) continue;
        wall = true;
        const steps = Math.ceil(gap) + extend * 2;
        const sx = gx / gap;
        const sz = gz / gap;
        for (let i = -extend; i <= steps; i++) {
            mark(prev.x + sx * i, prev.z + sz * i);
        }
    }

    return { cell, marked, wall };
}

/* ── A* с обходом блокировок ───────────────────────────────────────────── */

/** Бинарная куча — маршрут не должен подвешивать event loop воркера. */
function createMinHeap() {
    const items = [];
    const swap = (i, j) => {
        const t = items[i];
        items[i] = items[j];
        items[j] = t;
    };
    return {
        get size() {
            return items.length;
        },
        push(key, priority) {
            items.push({ key, priority });
            let i = items.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (items[p].priority <= items[i].priority) break;
                swap(p, i);
                i = p;
            }
        },
        pop() {
            if (!items.length) return null;
            const top = items[0];
            const last = items.pop();
            if (items.length) {
                items[0] = last;
                let i = 0;
                for (;;) {
                    const l = i * 2 + 1;
                    const r = l + 1;
                    let m = i;
                    if (l < items.length && items[l].priority < items[m].priority) m = l;
                    if (r < items.length && items[r].priority < items[m].priority) m = r;
                    if (m === i) break;
                    swap(m, i);
                    i = m;
                }
            }
            return top;
        },
    };
}

/**
 * A* по плоской сетке с чёрным списком клеток.
 * @returns {{x:number,y:number,z:number}[] | null}
 */
export function astarAvoiding(cells, start, goal, { blocked = null } = {}) {
    const sk = cellKey(start.x, start.z);
    const gk = cellKey(goal.x, goal.z);
    if (!cells[sk] || !cells[gk]) return null;
    if (sk === gk) return [{ x: start.x, y: cells[sk].y, z: start.z }];
    if (blocked?.has(gk)) return null;

    const open = createMinHeap();
    const came = new Map();
    const gScore = new Map([[sk, 0]]);
    const closed = new Set();
    const h = (x, z) => Math.abs(x - goal.x) + Math.abs(z - goal.z);

    open.push(sk, h(start.x, start.z));

    while (open.size) {
        const cur = open.pop();
        if (!cur || closed.has(cur.key)) continue;
        closed.add(cur.key);

        if (cur.key === gk) {
            const path = [];
            let k = gk;
            while (k) {
                const cell = cells[k];
                path.push({ x: cell.x, y: cell.y, z: cell.z });
                k = came.get(k);
            }
            path.reverse();
            return path;
        }

        const curCell = cells[cur.key];
        const baseG = gScore.get(cur.key) ?? Infinity;
        for (const [nx, nz] of neighbors4(curCell.x, curCell.z)) {
            const nk = cellKey(nx, nz);
            const next = cells[nk];
            if (!next || closed.has(nk)) continue;
            if (blocked?.has(nk)) continue;
            if (!canStepFlat(curCell, next)) continue;
            const tentative = baseG + 1;
            if (tentative >= (gScore.get(nk) ?? Infinity)) continue;
            came.set(nk, cur.key);
            gScore.set(nk, tentative);
            open.push(nk, tentative + h(nx, nz));
        }
    }
    return null;
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

export function nearestCell(cells, x, z) {
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

/** Геометрия территории: центр масс, хаб варпа, радиус. */
export function mapGeometry(cells, warpOrigin = null) {
    const all = Object.values(cells);
    const centroid = {
        x: all.reduce((s, c) => s + c.x, 0) / all.length,
        z: all.reduce((s, c) => s + c.z, 0) / all.length,
    };
    const hub = warpOrigin && Number.isFinite(warpOrigin.x)
        ? { x: warpOrigin.x, z: warpOrigin.z }
        : centroid;
    let maxHubR = 1;
    for (const c of all) {
        maxHubR = Math.max(maxHubR, Math.hypot(c.x - hub.x, c.z - hub.z));
    }
    return { all, centroid, hub, maxHubR };
}

/** Сектор бота: одинаковый ник → одинаковый угол территории. */
export function sectorForUser(username, sectors = DEFAULTS.sectors) {
    return hash32(`${username}:shop-sector`) % sectors;
}

/**
 * Цель очередной ноги: свой сектор, подальше от хаба варпа, вне чёрного списка.
 */
export function pickSpreadGoal(cells, from, {
    username = '',
    legIndex = 0,
    goalDistMin = DEFAULTS.goalDistMin,
    goalDistMax = DEFAULTS.goalDistMax,
    sectors = DEFAULTS.sectors,
    geometry = null,
    blocked = null,
    rng = Math.random,
} = {}) {
    const geo = geometry || mapGeometry(cells);
    const { all, centroid, hub, maxHubR } = geo;
    // чередуем сектора: свой → +3 → +6 → … чтобы охватывать всю площадь
    const sector = (sectorForUser(username, sectors) + legIndex * 3) % sectors;
    const preferDist = goalDistMin + rng() * (goalDistMax - goalDistMin);

    let best = null;
    let bestScore = -Infinity;
    const tries = Math.min(160, all.length);
    for (let t = 0; t < tries; t++) {
        const c = all[Math.floor(rng() * all.length)];
        if (blocked?.has(cellKey(c.x, c.z))) continue;
        const dist = Math.hypot(c.x - from.x, c.z - from.z);
        if (dist < goalDistMin * 0.55 || dist > goalDistMax * 1.5) continue;

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
        const edgeBonus = (hubDist / maxHubR) * 35;
        const distScore = -Math.abs(dist - preferDist) * 0.35;
        const leaveHub = legIndex === 0 ? hubDist * 0.4 : hubDist * 0.1;

        const score = sectorBonus + edgeBonus + distScore + leaveHub + rng() * 4;
        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }

    if (!best) {
        for (const c of all) {
            if (blocked?.has(cellKey(c.x, c.z))) continue;
            const si = Math.min(
                sectors - 1,
                Math.floor((cellAngle(centroid, c) / (Math.PI * 2)) * sectors),
            );
            if (si !== sector) continue;
            const score = Math.hypot(c.x - hub.x, c.z - hub.z) + rng();
            if (score > bestScore) {
                bestScore = score;
                best = c;
            }
        }
    }
    return best;
}

/**
 * Обход препятствия: путь от текущей позиции к вейпоинту мимо чёрного списка.
 * @returns {{x:number,y:number,z:number}[]} без стартовой клетки
 */
export function replanLeg(cells, fromPos, waypoint, {
    blocked = null,
    simplifyEpsilon = DEFAULTS.simplifyEpsilon,
} = {}) {
    const from = nearestCell(cells, fromPos.x, fromPos.z);
    const to = nearestCell(cells, waypoint.x, waypoint.z);
    if (!from || !to) return [];
    const path = astarAvoiding(cells, from, to, { blocked });
    if (!path || path.length < 2) return [];
    return simplifyPath(path, simplifyEpsilon).slice(1);
}

/**
 * Маршрут на весь запуск: цепочка целей по всей территории.
 * Ноги чередуют сектора и тянутся к краям, а не к точке варпа.
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
    blocked = null,
    rng = Math.random,
    log = null,
} = {}) {
    const start = nearestCell(cells, startPos.x, startPos.z);
    if (!start) return [];

    const geo = mapGeometry(cells, warpOrigin);
    if (geo.all.length < 30) return [];

    const nLegs = legsMin + Math.floor(rng() * (Math.max(0, legsMax - legsMin) + 1));
    const waypoints = [{ x: start.x, y: start.y, z: start.z }];
    let from = start;
    let made = 0;

    for (let i = 0; i < nLegs; i++) {
        const goal = pickSpreadGoal(cells, from, {
            username,
            legIndex: i,
            goalDistMin,
            goalDistMax,
            sectors,
            geometry: geo,
            blocked,
            rng,
        });
        if (!goal) break;
        const path = astarAvoiding(cells, from, goal, { blocked });
        if (!path || path.length < 2) continue;
        for (let j = 1; j < path.length; j++) waypoints.push(path[j]);
        from = goal;
        made += 1;
    }

    const simplified = simplifyPath(waypoints, simplifyEpsilon);
    const end = simplified[simplified.length - 1] || start;
    const leave = Math.hypot(end.x - geo.hub.x, end.z - geo.hub.z);
    log?.(
        `shop-map → route pts=${simplified.length} legs=${made}/${nLegs}`
        + ` sector0=${sectorForUser(username, sectors)}/${sectors}`
        + ` start=(${start.x},${start.z}) end=(${end.x},${end.z})`
        + ` leaveHub=${leave.toFixed(0)}/${geo.maxHubR.toFixed(0)}`,
    );
    return simplified;
}
