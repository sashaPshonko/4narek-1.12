/**
 * Растущая карта проходимой территории: дамп вокруг бота → связная область →
 * случайные A*-маршруты с разводом ботов по секторам.
 *
 * Карта не привязана к фиксированному радиусу: когда бот уходит от последнего
 * скана дальше rescanDist, сканируется новый круг и вливается в старую карту.
 * Границы задают только запретные зоны (lib/zones.mjs) и сама проходимость —
 * в графе нет клеток, куда нельзя шагнуть, поэтому в яму пути не будет.
 */

import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    dumpWalkableGrid,
    loadCellsFromSpawnMap,
} from './spawn-map.mjs';
import { NO_ZONES } from './zones.mjs';

const ORCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SHOP_MAP_PATH = join(ORCH_ROOT, 'shop-map.json');
export const SHOP_DUMP_REQUEST_PATH = join(ORCH_ROOT, 'shop-map.dump-request');
/** Общая на все воркеры память о непроходимых клетках (прилавки, заборы, чужие боты). */
export const SHOP_BLOCKED_PATH = join(ORCH_ROOT, 'shop-blocked.json');

const DEFAULTS = {
    radiusXZ: 110,
    minFlatCells: 400,
    /** 0 = многоуровневая карта (лестницы, помосты); >0 — только одна плоскость */
    yBand: 0,
    maxAgeMs: 12 * 60 * 60 * 1000,
    legsMin: 5,
    legsMax: 9,
    goalDistMin: 18,
    goalDistMax: 48,
    sectors: 12,
    blockedTtlMs: 3 * 60 * 60 * 1000,
    blockedMaxCells: 8000,
    /** отошёл от центра последнего скана дальше — досканируем и вольём */
    rescanDist: 55,
    /** потолок памяти карты; лишнее режем по удалённости от бота */
    maxCells: 160_000,
    /** насколько сильно тянет в неисхоженное (0 — выключить) */
    freshBonus: 30,
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
 * Клетка → точка, куда реально идти.
 *
 * Клетки — это индексы блоков, а блок (x,z) занимает мир [x,x+1]×[z,z+1].
 * Идти в «x,z» значит целиться в стык четырёх блоков: хитбокс шириной 0.6
 * влезает в три соседних столбца, которые никто не проверял, и бот скребёт
 * стену. Центр блока — единственная точка, где он стоит внутри своей клетки.
 */
export function cellPoint(cell) {
    return { x: cell.x + 0.5, y: cell.y, z: cell.z + 0.5 };
}

/** Мировая координата → индекс блока. */
function blockIndex(v) {
    return Math.floor(v);
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
        // координаты мировые (центры блоков, позиция бота) — не round, а floor
        const k = cellKey(Math.floor(x), Math.floor(z));
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

function dominantY(list) {
    const yCount = new Map();
    for (const c of list) {
        const y = Math.round(c.y);
        yCount.set(y, (yCount.get(y) || 0) + 1);
    }
    let flatY = list[0]?.y ?? 0;
    let bestN = 0;
    for (const [y, n] of yCount) {
        if (n > bestN) {
            bestN = n;
            flatY = y;
        }
    }
    return flatY;
}

/**
 * Крупнейшая связная область, по которой реально можно пройти.
 *
 * Раньше сначала резали по доминирующей высоте ±1, и лестницы, помосты,
 * нижние улицы выпадали из карты целиком. Проходимость и так проверяется
 * пошагово (перепад ≤1 между соседями), так что абсолютная полоса только
 * отрезала площадь. yBand>0 возвращает старое поведение — одна плоскость.
 *
 * @returns {{ cells: object, flatY: number, walkableCount: number, ySpread: number } | null}
 */
export function extractLargestFlatComponent(cells, {
    yBand = DEFAULTS.yBand,
    zones = NO_ZONES,
    from = null,
} = {}) {
    const all = cells || Object.create(null);
    const list = Object.values(all);
    if (list.length < 20) return null;

    // запретные зоны выкидываем ДО поиска компоненты: клетки нет в графе —
    // значит ни цель, ни A* туда попасть физически не могут
    let pool = Object.create(null);
    let banned = 0;
    for (const c of list) {
        if (zones?.hit && zones.hit(c.x, c.y, c.z)) {
            banned++;
            continue;
        }
        pool[cellKey(c.x, c.z)] = c;
    }

    if (Number.isFinite(yBand) && yBand > 0) {
        const flatY = dominantY(Object.values(pool));
        const band = Object.create(null);
        for (const c of Object.values(pool)) {
            if (Math.abs(c.y - flatY) <= yBand) band[cellKey(c.x, c.z)] = c;
        }
        pool = band;
    }

    const grow = (startK) => {
        const q = [startK];
        const seen = new Set(q);
        // обход по индексу, не shift(): на десятках тысяч клеток сдвиг
        // массива превращает BFS в O(n²) и вешает воркер
        for (let qi = 0; qi < q.length; qi++) {
            const cur = pool[q[qi]];
            for (const [nx, nz] of neighbors4(cur.x, cur.z)) {
                const nk = cellKey(nx, nz);
                if (seen.has(nk) || !pool[nk]) continue;
                if (!canStepFlat(cur, pool[nk])) continue;
                seen.add(nk);
                q.push(nk);
            }
        }
        return q;
    };

    let comp = null;
    // если сказано «от бота» — берём именно достижимое им, а не крупнейшее:
    // на растущей карте крупнейший кусок может оказаться за стеной
    if (from) {
        const seed = nearestCell(pool, from.x, from.z);
        if (seed && Math.hypot(seed.x - from.x, seed.z - from.z) <= 6) {
            comp = grow(cellKey(seed.x, seed.z));
        }
    }
    if (!comp) {
        const seen = new Set();
        let best = [];
        for (const startK of Object.keys(pool)) {
            if (seen.has(startK)) continue;
            const q = grow(startK);
            for (const k of q) seen.add(k);
            if (q.length > best.length) best = q;
        }
        comp = best;
    }

    if (!comp || comp.length < 20) return null;
    const out = Object.create(null);
    const picked = [];
    let minY = Infinity;
    let maxY = -Infinity;
    for (const k of comp) {
        const c = pool[k];
        out[k] = c;
        picked.push(c);
        if (c.y < minY) minY = c.y;
        if (c.y > maxY) maxY = c.y;
    }
    return {
        cells: out,
        flatY: dominantY(picked),
        walkableCount: comp.length,
        ySpread: maxY - minY,
        bannedCells: banned,
    };
}

/** Слить свежий дамп в уже известную карту. Новые клетки перетирают старые. */
export function mergeCells(base, add) {
    const out = Object.create(null);
    for (const [k, v] of Object.entries(base || {})) out[k] = v;
    for (const [k, v] of Object.entries(add || {})) out[k] = v;
    return out;
}

/** Потолок памяти: держим то, что ближе к боту. */
export function pruneFarCells(cells, center, maxCells = DEFAULTS.maxCells) {
    const list = Object.values(cells || {});
    if (list.length <= maxCells) return cells;
    list.sort((a, b) => (
        Math.hypot(a.x - center.x, a.z - center.z)
        - Math.hypot(b.x - center.x, b.z - center.z)
    ));
    const out = Object.create(null);
    for (let i = 0; i < maxCells; i++) {
        const c = list[i];
        out[cellKey(c.x, c.z)] = c;
    }
    return out;
}

/**
 * Можно ли пройти по прямой a→b (мировые координаты), не задев стену.
 *
 * Проверяем не центр шага, а четыре угла хитбокса: бот шириной ~0.6, и на
 * диагонали он краем влезает в соседние столбцы. Если такой столбец не в
 * карте — там стена или дыра, и по этой прямой идти нельзя.
 */
export function segmentWalkable(cells, a, b, { half = 0.32 } = {}) {
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-6) return true;
    // шаг 0.25 блока: угол хитбокса не должен «перепрыгнуть» столбец
    const steps = Math.max(2, Math.ceil(dist * 4));
    let prevY = a.y;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const px = a.x + dx * t;
        const pz = a.z + dz * t;
        let stepY = null;
        for (const ox of [-half, half]) {
            for (const oz of [-half, half]) {
                const c = cells[cellKey(blockIndex(px + ox), blockIndex(pz + oz))];
                if (!c) return false;
                if (Math.abs(c.y - prevY) > 1.01) return false;
                if (stepY == null || c.y > stepY) stepY = c.y;
            }
        }
        prevY = stepY;
    }
    return true;
}

/**
 * Спрямление пути с проверкой земли под срезаемым углом.
 *
 * RDP спрямлял «на глаз» и мог срезать угол через дыру: гарантия у него —
 * отклонение ≤epsilon от ломаной, а не наличие пола. Здесь шорткат
 * принимается, только если по нему реально можно пройти.
 */
export function simplifyPathSafe(cells, points, { maxSkip = 32 } = {}) {
    if (!points || points.length <= 2) return points ? points.slice() : [];
    const out = [points[0]];
    let i = 0;
    while (i < points.length - 1) {
        let best = i + 1;
        const limit = Math.min(points.length - 1, i + maxSkip);
        for (let j = limit; j > i + 1; j--) {
            if (segmentWalkable(cells, points[i], points[j])) {
                best = j;
                break;
            }
        }
        out.push(points[best]);
        i = best;
    }
    return out;
}

function writeShopMapFile(dump, flat, path = SHOP_MAP_PATH, scans = []) {
    const walkable = Object.values(flat.cells).map((c) => [c.x, c.y, c.z, c.floor]);
    const out = {
        dumpedAt: dump.dumpedAt,
        origin: dump.origin,
        radiusXZ: dump.radiusXZ,
        flatY: flat.flatY,
        ySpread: flat.ySpread ?? 0,
        walkableCount: flat.walkableCount,
        rawWalkableCount: dump.walkableCount,
        /** центры уже отсканированных кругов — по ним решаем, где досканировать */
        scans,
        walkable,
    };
    writeFileSync(path, `${JSON.stringify(out)}\n`, 'utf8');
    return out;
}

/** Есть ли уже скан рядом с точкой. */
function scanCovers(scans, x, z, rescanDist) {
    for (const s of scans || []) {
        if (Math.hypot(s[0] - x, s[1] - z) < rescanDist) return true;
    }
    return false;
}

/**
 * Загрузка shop-map.json → cells (уже проходимая компонента).
 * Карта на радиус 110 — это мегабайты JSON, а читается она каждый цикл
 * прогулки, поэтому держим разбор в памяти до смены mtime.
 */
let shopMapCache = null;

export function loadShopMap(path = SHOP_MAP_PATH) {
    if (!existsSync(path)) return null;
    try {
        const stamp = statSync(path).mtimeMs;
        if (shopMapCache?.path === path && shopMapCache.stamp === stamp) {
            return shopMapCache.map;
        }
        const dump = loadCellsFromSpawnMap(path);
        if (!dump || dump.walkableCount < 20) return null;
        let scans = [];
        try {
            scans = JSON.parse(readFileSync(path, 'utf8')).scans || [];
        } catch {
            /* старый формат без scans — досканируем на месте */
        }
        const map = {
            ...dump,
            flatY: dump.flatY ?? dump.origin?.y,
            scans,
            path,
        };
        shopMapCache = { path, stamp, map };
        return map;
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
 * Скан вокруг бота → связная область → shop-map.json.
 *
 * Если карта уже есть, свежий дамп вливается в неё, а не заменяет: так
 * территория растёт по мере того, как бот уходит дальше.
 */
export async function dumpShopFlatMap(bot, {
    radiusXZ = DEFAULTS.radiusXZ,
    minFlatCells = DEFAULTS.minFlatCells,
    zones = NO_ZONES,
    maxCells = DEFAULTS.maxCells,
    merge = null,
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

    const here = { ...bot.entity.position };
    logFn?.(`shop-map → скан r=${radiusXZ} вокруг (${here.x.toFixed(0)},${here.z.toFixed(0)})…`);
    const dump = await dumpWalkableGrid(bot, { radiusXZ, log: logFn });

    const known = merge?.cells ? Object.keys(merge.cells).length : 0;
    let raw = dump.cells;
    if (known) raw = mergeCells(merge.cells, dump.cells);
    raw = pruneFarCells(raw, here, maxCells);

    // компонента именно от бота: на большой карте крупнейший кусок может
    // оказаться за забором, и бот бы «планировал» там, где его нет
    const flat = extractLargestFlatComponent(raw, { zones, from: here });
    if (!flat || flat.walkableCount < minFlatCells) {
        throw new Error(
            `flat_too_small (${flat?.walkableCount || 0}/${minFlatCells}, raw=${dump.walkableCount})`,
        );
    }

    const scans = [...(merge?.scans || []), [Math.round(here.x), Math.round(here.z), radiusXZ]];
    const meta = writeShopMapFile(dump, flat, path, scans);
    logFn?.(
        `shop-map → клеток=${flat.walkableCount}${known ? ` (было ${known})` : ''}`
        + ` Δy=${flat.ySpread} flatY=${flat.flatY}`
        + (flat.bannedCells ? ` вне зон=${flat.bannedCells}` : '')
        + ` сканов=${scans.length}`,
    );
    return {
        ...loadShopMap(path),
        meta,
    };
}

/**
 * Карта под текущее место бота.
 *
 * Карта не «устаревает целиком»: если бот ушёл дальше rescanDist от всех
 * прежних сканов, досканируем круг вокруг него и вольём в известное.
 * Так территория не ограничена радиусом — она растёт следом за ботом.
 */
export async function ensureShopFlatMap(bot, {
    radiusXZ = DEFAULTS.radiusXZ,
    minFlatCells = DEFAULTS.minFlatCells,
    maxAgeMs = DEFAULTS.maxAgeMs,
    rescanDist = DEFAULTS.rescanDist,
    maxCells = DEFAULTS.maxCells,
    zones = NO_ZONES,
    force = false,
    log = null,
    path = SHOP_MAP_PATH,
} = {}) {
    const wantForce = force || existsSync(SHOP_DUMP_REQUEST_PATH);
    const existing = loadShopMap(path);
    const here = bot?.entity?.position;

    const clearRequest = () => {
        if (!existsSync(SHOP_DUMP_REQUEST_PATH)) return;
        try {
            unlinkSync(SHOP_DUMP_REQUEST_PATH);
        } catch {
            /* ignore */
        }
    };

    if (!wantForce && existing && mapIsFresh(existing, maxAgeMs)
        && existing.walkableCount >= minFlatCells) {
        const covered = here && scanCovers(existing.scans, here.x, here.z, rescanDist);
        if (covered) {
            log?.(
                `shop-map → карта из кэша: клеток=${existing.walkableCount}`
                + ` сканов=${existing.scans?.length || 0}`,
            );
            return existing;
        }
        // бот в неизвестном углу — расширяем, а не строим заново
        log?.(
            `shop-map → бот ушёл за край известного (${here.x.toFixed(0)},${here.z.toFixed(0)}),`
            + ' досканирую',
        );
        try {
            const grown = await dumpShopFlatMap(bot, {
                radiusXZ,
                minFlatCells,
                zones,
                maxCells,
                merge: existing,
                log,
                path,
            });
            clearRequest();
            return grown;
        } catch (err) {
            log?.(`shop-map → расширение не удалось (${err?.message || err}), иду по старой`);
            return existing;
        }
    }

    const map = await dumpShopFlatMap(bot, {
        radiusXZ,
        minFlatCells,
        zones,
        maxCells,
        merge: wantForce ? null : existing,
        log,
        path,
    });
    clearRequest();
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
    const p = cellPoint(near);
    return Math.hypot(p.x - pos.x, p.z - pos.z) <= maxDist
        && Math.abs((p.y ?? pos.y) - pos.y) <= 2.5;
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

function gcd(a, b) {
    return b ? gcd(b, a % b) : a;
}

/**
 * Шаг обхода секторов. Обязан быть взаимно простым с их числом, иначе цепочка
 * замкнётся на части круга: 12 секторов шагом 3 дают всего 4 из 12.
 * Целимся примерно в 0.4 оборота — соседние ноги уходят далеко друг от друга.
 */
export function sectorStep(sectors = DEFAULTS.sectors) {
    const want = Math.max(1, Math.round(sectors * 0.4));
    for (let d = 0; d < sectors; d++) {
        for (const s of [want + d, want - d]) {
            if (s >= 1 && s < sectors && gcd(s, sectors) === 1) return s;
        }
    }
    return 1;
}

/** Огрубление до 16-блочных квадратов: где бот уже топтался. */
export function visitKey(x, z) {
    return `${Math.floor(x / 16)},${Math.floor(z / 16)}`;
}

/**
 * Цель очередной ноги: свой сектор, подальше от хаба, в неисхоженное,
 * вне чёрного списка.
 */
export function pickSpreadGoal(cells, from, {
    username = '',
    legIndex = 0,
    goalDistMin = DEFAULTS.goalDistMin,
    goalDistMax = DEFAULTS.goalDistMax,
    sectors = DEFAULTS.sectors,
    geometry = null,
    blocked = null,
    visited = null,
    freshBonus = DEFAULTS.freshBonus,
    rng = Math.random,
} = {}) {
    const geo = geometry || mapGeometry(cells);
    const { all, centroid, hub, maxHubR } = geo;
    // чередуем сектора по всему кругу, чтобы охватывать всю площадь
    const sector = (sectorForUser(username, sectors) + legIndex * sectorStep(sectors)) % sectors;
    const preferDist = goalDistMin + rng() * (goalDistMax - goalDistMin);

    let best = null;
    let bestScore = -Infinity;
    const tries = Math.min(240, all.length);
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
        // на бесконечной территории нет смысла нарезать круги по своим следам
        const seen = visited?.get(visitKey(c.x, c.z)) || 0;
        const freshScore = seen ? -Math.min(freshBonus, seen * 12) : freshBonus;

        const score = sectorBonus + edgeBonus + distScore + leaveHub + freshScore + rng() * 4;
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
} = {}) {
    const from = nearestCell(cells, fromPos.x, fromPos.z);
    const to = nearestCell(cells, waypoint.x, waypoint.z);
    if (!from || !to) return [];
    const path = astarAvoiding(cells, from, to, { blocked });
    if (!path || path.length < 2) return [];
    return simplifyPathSafe(cells, path.map(cellPoint)).slice(1);
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
    sectors = DEFAULTS.sectors,
    warpOrigin = null,
    blocked = null,
    visited = null,
    freshBonus = DEFAULTS.freshBonus,
    rng = Math.random,
    log = null,
} = {}) {
    const start = nearestCell(cells, startPos.x, startPos.z);
    if (!start) return [];

    const geo = mapGeometry(cells, warpOrigin);
    if (geo.all.length < 30) return [];

    const nLegs = legsMin + Math.floor(rng() * (Math.max(0, legsMax - legsMin) + 1));
    const waypoints = [cellPoint(start)];
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
            visited,
            freshBonus,
            rng,
        });
        if (!goal) break;
        const path = astarAvoiding(cells, from, goal, { blocked });
        if (!path || path.length < 2) continue;
        for (let j = 1; j < path.length; j++) waypoints.push(cellPoint(path[j]));
        from = goal;
        made += 1;
    }

    // спрямляем только там, где под срезом действительно есть пол
    const simplified = simplifyPathSafe(cells, waypoints);
    const end = simplified[simplified.length - 1] || cellPoint(start);
    const leave = Math.hypot(end.x - geo.hub.x, end.z - geo.hub.z);
    log?.(
        `shop-map → route pts=${simplified.length} legs=${made}/${nLegs}`
        + ` sector0=${sectorForUser(username, sectors)}/${sectors}`
        + ` start=(${start.x},${start.z}) end=(${Math.floor(end.x)},${Math.floor(end.z)})`
        + ` leaveHub=${leave.toFixed(0)}/${geo.maxHubR.toFixed(0)}`,
    );
    return simplified;
}
