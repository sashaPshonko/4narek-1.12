/**
 * Защита слепого WASD от провала в яму (anti-AFK без shop-map).
 * Карта walk ямы режет сама; здесь — только blockAt под/перед ногами.
 */

import { Vec3 } from 'vec3';

const MAX_STEP_DOWN = 1.01;
const MAX_STEP_UP = 1.01;
/** Как далеко смотреть по направлению клавиши (до центра соседней клетки). */
const AHEAD_DISTS = [0.55, 0.95, 1.35, 1.75];
const SIDE = 0.28;

function isAirLike(block) {
    if (!block) return true;
    const n = block.name || '';
    if (n === 'air' || n === 'cave_air' || n === 'void_air' || n === 'light' || n === 'snow') {
        return true;
    }
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
    if (n.includes('leaves') || n.includes('vine') || n.includes('azalea')) return false;
    return (
        block.boundingBox === 'block'
        || n.includes('slab')
        || n.includes('stairs')
        || n.includes('carpet')
    );
}

function blockAt(bot, x, y, z) {
    try {
        return bot.blockAt(new Vec3(x, y, z));
    } catch {
        return null;
    }
}

function lookXZ(yaw) {
    return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/** Направление WASD относительно yaw (голова не крутится). */
export function keyDirXZ(yaw, key) {
    const f = lookXZ(yaw);
    const left = { x: f.z, z: -f.x };
    if (key === 'forward') return f;
    if (key === 'back') return { x: -f.x, z: -f.z };
    if (key === 'left') return left;
    if (key === 'right') return { x: -left.x, z: -left.z };
    return f;
}

/**
 * Высота ног, если в столбце (x,z) есть пол не ниже preferFeetY − maxDown
 * и не выше preferFeetY + maxUp. Иначе null (яма / обрыв / неизвестно).
 */
function probeFeetY(bot, x, z, preferFeetY, {
    maxDown = MAX_STEP_DOWN,
    maxUp = MAX_STEP_UP,
} = {}) {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    const y0 = Math.floor(preferFeetY + 0.05);
    // пол под ногами: block y = feetY - 1
    const yLo = y0 - Math.ceil(maxDown) - 1;
    const yHi = y0 + Math.ceil(maxUp);
    for (let floorY = yHi; floorY >= yLo; floorY--) {
        const floor = blockAt(bot, ix, floorY, iz);
        if (!isStandableFloor(floor)) continue;
        const feet = blockAt(bot, ix, floorY + 1, iz);
        const head = blockAt(bot, ix, floorY + 2, iz);
        if (!isAirLike(feet) || !isAirLike(head)) continue;
        const feetY = floorY + 1;
        if (feetY < preferFeetY - maxDown) continue;
        if (feetY > preferFeetY + maxUp) continue;
        return feetY;
    }
    return null;
}

/** Стоим на полу (не в полёте над ямой). */
export function isStandingOnFloor(bot) {
    const pos = bot?.entity?.position;
    if (!pos) return false;
    return probeFeetY(bot, pos.x, pos.z, pos.y, { maxDown: 1.25, maxUp: 0.6 }) != null;
}

/**
 * Клавиша ведёт к обрыву/яме глубже 1 блока (или в непрогруженный столб → осторожно skip).
 * @returns {boolean} true = опасно, жать нельзя
 */
export function keyWouldFall(bot, key) {
    const ent = bot?.entity;
    if (!ent?.position || !Number.isFinite(ent.yaw)) return true;
    const pos = ent.position;
    const dir = keyDirXZ(ent.yaw, key);
    const sideX = -dir.z * SIDE;
    const sideZ = dir.x * SIDE;

    for (const dist of AHEAD_DISTS) {
        const samples = [
            [pos.x + dir.x * dist, pos.z + dir.z * dist],
            [pos.x + dir.x * dist + sideX, pos.z + dir.z * dist + sideZ],
            [pos.x + dir.x * dist - sideX, pos.z + dir.z * dist - sideZ],
        ];
        for (const [sx, sz] of samples) {
            const feetY = probeFeetY(bot, sx, sz, pos.y);
            if (feetY == null) return true;
        }
    }
    return false;
}

/**
 * Следующая безопасная клавиша из карусели, либо null если все 4 ведут в яму.
 * @param {{ keyIndex: number }} st
 */
export function nextSafeWasdKey(bot, st, keys = ['forward', 'left', 'back', 'right']) {
    if (!isStandingOnFloor(bot)) return null;
    for (let i = 0; i < keys.length; i++) {
        const key = keys[st.keyIndex % keys.length];
        st.keyIndex = (st.keyIndex + 1) % keys.length;
        if (!keyWouldFall(bot, key)) return key;
    }
    return null;
}
