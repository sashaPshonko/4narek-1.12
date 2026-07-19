/**
 * Числовые id зачаров = minecraft-data / bot.registry для 1.21.11
 * (на FunTime ваниль совпадает; кастом — через lore / custom-enchantments).
 */
import mcData from 'minecraft-data';

export const MC_VERSION = '1.21.11';

const data = mcData(MC_VERSION);
if (!data?.enchantmentsArray?.length) {
    throw new Error(`minecraft-data: нет enchantments для ${MC_VERSION}`);
}

export const FUNTIME_ENCHANT_BY_ID = new Map(
    data.enchantmentsArray.map((e) => [e.id, `minecraft:${e.name}`]),
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

/** Совместимость API. */
export function refreshFuntimeEnchantNames() {
    vanillaShortNames = buildVanillaShortNames();
}

refreshFuntimeEnchantNames();
