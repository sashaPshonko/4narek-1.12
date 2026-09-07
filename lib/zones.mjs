/**
 * Запретные зоны — объявляются координатами в walk-route.json, не кодом.
 *
 *   "forbiddenZones": [
 *     { "name": "pvp",       "z": ">105" },
 *     { "name": "автошахта", "from": [-47, 46], "to": [-71, 22] },
 *     { "name": "склад",     "x": "-40..10", "z": ">200" }
 *   ]
 *
 * Внутри одной записи оси объединяются по И — это коробка.
 * Разные записи — по ИЛИ.
 *
 * Формат оси: ">105", ">=105", "<-40", "<=0", "20..90", "105"
 * или объект { "min": 20, "max": 90 }.
 *
 * Квадрат/коробка по двум углам: from/to = [x, z] или [x, y, z].
 * Порядок углов не важен — берём min/max по каждой оси.
 */

const AXES = ['x', 'y', 'z'];
const NUM = '-?\\d+(?:\\.\\d+)?';

/**
 * @returns {{ min: number, max: number, minEx?: boolean, maxEx?: boolean } | null}
 */
export function parseRange(spec) {
    if (spec == null || spec === '') return null;

    if (typeof spec === 'number') {
        return Number.isFinite(spec) ? { min: spec, max: spec } : null;
    }

    if (typeof spec === 'object') {
        const min = Number(spec.min);
        const max = Number(spec.max);
        const hasMin = Number.isFinite(min);
        const hasMax = Number.isFinite(max);
        if (!hasMin && !hasMax) return null;
        return {
            min: hasMin ? min : -Infinity,
            max: hasMax ? max : Infinity,
            minEx: spec.minExclusive === true,
            maxEx: spec.maxExclusive === true,
        };
    }

    const s = String(spec).trim();
    let m;
    if ((m = s.match(new RegExp(`^>=\\s*(${NUM})$`)))) {
        return { min: Number(m[1]), max: Infinity };
    }
    if ((m = s.match(new RegExp(`^>\\s*(${NUM})$`)))) {
        return { min: Number(m[1]), max: Infinity, minEx: true };
    }
    if ((m = s.match(new RegExp(`^<=\\s*(${NUM})$`)))) {
        return { min: -Infinity, max: Number(m[1]) };
    }
    if ((m = s.match(new RegExp(`^<\\s*(${NUM})$`)))) {
        return { min: -Infinity, max: Number(m[1]), maxEx: true };
    }
    if ((m = s.match(new RegExp(`^(${NUM})\\s*\\.\\.\\s*(${NUM})$`)))) {
        const a = Number(m[1]);
        const b = Number(m[2]);
        return { min: Math.min(a, b), max: Math.max(a, b) };
    }
    if ((m = s.match(new RegExp(`^(${NUM})$`)))) {
        return { min: Number(m[1]), max: Number(m[1]) };
    }
    return null;
}

/** margin расширяет коробку наружу — к самой границе PvP не подходим вплотную. */
function inRange(v, r, margin = 0) {
    if (!r) return true;
    const min = r.min - margin;
    const max = r.max + margin;
    if (r.minEx ? v <= min : v < min) return false;
    if (r.maxEx ? v >= max : v > max) return false;
    return true;
}

/** from/to: [x,z] или [x,y,z] — два противоположных угла. */
function axesFromCorners(from, to) {
    if (!Array.isArray(from) || !Array.isArray(to)) return null;
    if (from.length < 2 || to.length < 2) return null;
    const ax = Number(from[0]);
    const az = Number(from[from.length === 3 ? 2 : 1]);
    const bx = Number(to[0]);
    const bz = Number(to[to.length === 3 ? 2 : 1]);
    if (![ax, az, bx, bz].every(Number.isFinite)) return null;
    const axes = {
        x: { min: Math.min(ax, bx), max: Math.max(ax, bx) },
        z: { min: Math.min(az, bz), max: Math.max(az, bz) },
    };
    if (from.length === 3 && to.length === 3) {
        const ay = Number(from[1]);
        const by = Number(to[1]);
        if (Number.isFinite(ay) && Number.isFinite(by)) {
            axes.y = { min: Math.min(ay, by), max: Math.max(ay, by) };
        }
    }
    return axes;
}

function describeRange(r) {
    if (r.min === -Infinity) return `${r.maxEx ? '<' : '<='}${r.max}`;
    if (r.max === Infinity) return `${r.minEx ? '>' : '>='}${r.min}`;
    if (r.min === r.max) return `=${r.min}`;
    return `${r.min}..${r.max}`;
}

/**
 * @param {unknown} raw — массив из walk-route.json
 * @returns {{
 *   list: {name: string, axes: object, text: string}[],
 *   size: number,
 *   margin: number,
 *   hit: (x: number, y: number, z: number, margin?: number) => string|null,
 *   blocks: (pos: object, margin?: number) => string|null,
 *   describe: () => string,
 * }}
 */
export function compileZones(raw, { margin = 2, log = null } = {}) {
    const list = [];

    for (const entry of Array.isArray(raw) ? raw : []) {
        if (!entry || typeof entry !== 'object') continue;
        const name = String(entry.name || `зона${list.length + 1}`);
        const axes = {};
        let bad = false;
        if (entry.from != null || entry.to != null) {
            const box = axesFromCorners(entry.from, entry.to);
            if (!box) {
                log?.(`zones → «${name}»: не понял from/to, зона пропущена`);
                continue;
            }
            Object.assign(axes, box);
        }
        for (const ax of AXES) {
            if (!(ax in entry) || entry[ax] == null || entry[ax] === '') continue;
            const r = parseRange(entry[ax]);
            if (!r) {
                log?.(`zones → «${name}»: не понял ${ax}=${JSON.stringify(entry[ax])}, зона пропущена`);
                bad = true;
                break;
            }
            axes[ax] = r;
        }
        if (bad) continue;
        // без единой оси коробка накрыла бы весь мир — это точно опечатка
        if (!Object.keys(axes).length) {
            log?.(`zones → «${name}»: нет ни одной оси, зона пропущена`);
            continue;
        }
        const text = `${name}: ${AXES.filter((a) => axes[a])
            .map((a) => `${a}${describeRange(axes[a])}`)
            .join(' и ')}`;
        list.push({ name, axes, text });
    }

    const safeMargin = Number.isFinite(Number(margin)) ? Math.max(0, Number(margin)) : 2;

    const hit = (x, y, z, m = safeMargin) => {
        for (const zone of list) {
            const { axes } = zone;
            if (axes.x && !inRange(x, axes.x, m)) continue;
            if (axes.y && !inRange(y, axes.y, m)) continue;
            if (axes.z && !inRange(z, axes.z, m)) continue;
            return zone.name;
        }
        return null;
    };

    return {
        list,
        size: list.length,
        margin: safeMargin,
        hit,
        blocks(pos, m = safeMargin) {
            if (!pos) return null;
            return hit(Number(pos.x), Number(pos.y ?? 0), Number(pos.z), m);
        },
        describe() {
            return list.length ? list.map((z) => z.text).join('; ') : 'нет';
        },
    };
}

/** Пустой набор — когда зоны не заданы. */
export const NO_ZONES = compileZones([]);
