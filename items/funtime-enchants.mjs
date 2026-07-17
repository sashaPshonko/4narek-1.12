/**
 * FunTime numeric enchant ids (4narek-old + invvv).
 * НЕ minecraft-data и НЕ bot.registry — только эта таблица.
 */
export const FUNTIME_ENCHANT_BY_ID = new Map(
    Object.entries({
        0: 'minecraft:aqua_affinity',
        1: 'minecraft:aqua_affinity',
        2: 'minecraft:binding_curse',
        3: 'minecraft:blast_protection',
        7: 'minecraft:depth_strider',
        8: 'minecraft:efficiency',
        9: 'minecraft:feather_falling',
        10: 'minecraft:fire_aspect',
        11: 'minecraft:fire_protection',
        13: 'minecraft:fortune',
        17: 'minecraft:knockback',
        18: 'minecraft:looting',
        23: 'minecraft:mending',
        26: 'minecraft:projectile_protection',
        27: 'minecraft:projectile_protection',
        28: 'minecraft:protection',
        31: 'minecraft:respiration',
        33: 'minecraft:sharpness',
        // invvv: меч slot 9 — небесная кара I
        35: 'minecraft:smite',
        // invvv: книга «душа» — раньше ошибочно был sweeping на 36
        36: 'minecraft:soul_speed',
        // invvv: меч slot 10 — разящий клинок III (раньше был id 36)
        37: 'minecraft:sweeping_edge',
        39: 'minecraft:thorns',
        40: 'minecraft:unbreaking',
        41: 'minecraft:vanishing_curse',
    }).map(([k, v]) => [Number(k), v]),
);

let vanillaShortNames = buildVanillaShortNames();

export function buildVanillaShortNames() {
    const shorts = new Set(['sweeping_edge']);
    for (const name of FUNTIME_ENCHANT_BY_ID.values()) {
        shorts.add(name.replace('minecraft:', ''));
    }
    return shorts;
}

export function normalizeFuntimeEnchantName(name) {
    if (name == null || name === '') return '';
    let n = String(name);
    if (n === 'minecraft:sweeping' || n === 'sweeping') n = 'minecraft:sweeping_edge';
    if (n === 'sweeping_edge') n = 'minecraft:sweeping_edge';
    if (n.includes(':')) return n;
    if (vanillaShortNames.has(n)) return `minecraft:${n}`;
    return n;
}

export function resolveFuntimeEnchantId(id) {
    if (typeof id === 'string' && (id.includes(':') || /[a-z]/i.test(id))) {
        return normalizeFuntimeEnchantName(id);
    }
    const num = Number(id);
    if (!Number.isFinite(num)) return null;
    return FUNTIME_ENCHANT_BY_ID.get(num) || null;
}

/** Совместимость: registry на FT не трогаем. */
export function refreshFuntimeEnchantNames() {
    vanillaShortNames = buildVanillaShortNames();
}

refreshFuntimeEnchantNames();
