/** Запрещённые чары по minecraft-типу (name в каталоге). Исключения — forbidden_effects у id в items_config.json */
const forbiddenEnchantsByType = {
    netherite_sword: ['heavy', 'unstable'],
    diamond_sword: ['heavy', 'unstable'],
    netherite_helmet: ['minecraft:thorns'],
    netherite_chestplate: ['minecraft:thorns'],
    netherite_leggings: ['minecraft:thorns'],
    netherite_boots: ['minecraft:thorns'],
    netherite_pickaxe: ['heavy', 'unstable'],
    elytra: [],
};

const numericToName = {
    33: 'minecraft:sharpness',
    10: 'minecraft:fire_aspect',
    40: 'minecraft:unbreaking',
    36: 'minecraft:sweeping',
    17: 'minecraft:knockback',
    18: 'minecraft:looting',
    28: 'minecraft:protection',
    27: 'minecraft:projectile_protection',
    23: 'minecraft:mending',
    39: 'minecraft:thorns',
    11: 'minecraft:fire_protection',
    1: 'minecraft:aqua_affinity',
    31: 'minecraft:respiration',
    7: 'minecraft:depth_strider',
    9: 'minecraft:feather_falling',
    13: 'minecraft:fortune',
    8: 'minecraft:efficiency',
};

const customNameMap = {
    'Яд': 'poison',
    'Вампиризм': 'vampirism',
    'Детекция': 'detection',
    'Тяжелый': 'heavy',
    'Нестабильный': 'unstable',
    'Бульдозер': 'buldozing',
    'Магнит': 'magnet',
    'Паутина': 'web',
    'Авто-плавка': 'smelting',
};

export function getDurabilityPercent(item) {
    if (!item.maxDurability) return 1;
    const damageComp = item.components?.find((c) => c.type === 'damage');
    const damage = damageComp?.data || 0;
    return (item.maxDurability - damage) / item.maxDurability;
}

function priceWithDurability(basePriceSell, durabilityPercent) {
    if (durabilityPercent < 0.5) return 0;
    let price = Math.floor(basePriceSell * durabilityPercent);
    const marker = basePriceSell % 100;
    price = Math.floor(price / 100) * 100 + marker;
    return price;
}

function getForbiddenEffectNames(configItem) {
    const byType = forbiddenEnchantsByType[configItem?.name] ?? [];
    const extra = configItem?.forbidden_effects ?? configItem?.forbiddenEffects;
    const fromItem = Array.isArray(extra) ? extra.map((e) => e?.name).filter(Boolean) : [];
    return [...new Set([...byType, ...fromItem])];
}

function hasForbiddenEnchant(allEnchants, forbiddenList = [], configEffects = []) {
    if (!forbiddenList?.length) return false;
    const allowedByConfig = new Set((configEffects || []).map((e) => e?.name).filter(Boolean));
    return allEnchants.some((enchant) => {
        if (!enchant?.name) return false;
        if (allowedByConfig.has(enchant.name)) return false;
        return forbiddenList.includes(enchant.name);
    });
}

function romanToArabic(roman) {
    const map = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10 };
    return map[roman] || 1;
}

function extractCustomEnchantsFromItem(item) {
    const result = [];
    try {
        const customDataComp = item.components?.find((c) => c.type === 'custom_data');
        const enchantsArray = customDataComp?.data?.value?.PublicBukkitValues?.value?.['minecraft:custom-enchantments']?.value?.value;
        if (Array.isArray(enchantsArray) && enchantsArray.length > 0) {
            for (const ench of enchantsArray) {
                const name = ench['minecraft:type']?.value;
                const lvl = ench['minecraft:level']?.value;
                if (name && typeof lvl === 'number') result.push({ name, lvl });
            }
            return result;
        }
    } catch { /* fallback ниже */ }

    const jsonStr = JSON.stringify(item);
    const valueRegex = /"value":"([^"]*)"/g;
    const matches = [];
    let match;
    while ((match = valueRegex.exec(jsonStr)) !== null) matches.push(match[1]);

    const textStrings = matches.filter((s) => {
        if (!s || typeof s !== 'string') return false;
        const trimmed = s.trim();
        if (!trimmed || /^#/.test(trimmed)) return false;
        return /[a-zA-Zа-яА-Я]/.test(trimmed);
    });

    const romanRegex = /^(I|II|III|IV|V|VI|VII|VIII|IX|X)$/;
    for (const str of textStrings) {
        const trimmed = str.trim();
        const lastSpaceIndex = trimmed.lastIndexOf(' ');
        if (lastSpaceIndex !== -1) {
            const possibleRoman = trimmed.substring(lastSpaceIndex + 1);
            if (romanRegex.test(possibleRoman)) {
                result.push({
                    name: trimmed.substring(0, lastSpaceIndex).trim(),
                    lvl: romanToArabic(possibleRoman),
                });
                continue;
            }
        }
        result.push({ name: trimmed, lvl: 1 });
    }
    return result;
}

function getConfigLoreMatch(config) {
    return config?.lore_match || config?.loreMatch || '';
}

function getItemLoreJson(item) {
    const loreComp = item?.components?.find((c) => c?.type === 'lore');
    if (!loreComp?.data) return '';
    return JSON.stringify(loreComp.data);
}

function loreMatchesConfig(item, config) {
    const needle = getConfigLoreMatch(config);
    if (!needle) return true;
    return getItemLoreJson(item).includes(needle);
}

function getVanillaEnchants(item) {
    const enchComponent = item.components?.find((c) => c?.type === 'enchantments');
    if (!enchComponent?.data?.enchantments) return [];
    return enchComponent.data.enchantments
        .map((e) => {
            if (!e) return null;
            let name = e.id;
            if (typeof name === 'number') name = numericToName[name] || `enchantment.${name}`;
            return { name, lvl: e.level ?? 1 };
        })
        .filter(Boolean);
}

function getAllEnchants(item) {
    const custom = extractCustomEnchantsFromItem(item).map((ench) => {
        const englishName = customNameMap[ench.name];
        return englishName ? { name: englishName, lvl: ench.lvl } : ench;
    });
    return [...getVanillaEnchants(item), ...custom];
}

export function findMatchingConfigItem(item, itemPrices, goType) {
    if (!item) return null;
    if (!Array.isArray(itemPrices)) {
        throw new Error(`itemPrices не массив (${typeof itemPrices})`);
    }
    if (!itemPrices.length) return null;

    let filtered = itemPrices.filter((c) => c?.id?.endsWith('1.21'));
    if (goType) filtered = filtered.filter((c) => c.type === goType);
    if (!filtered.length) return null;

    const sorted = [...filtered].sort((a, b) => b.num - a.num);
    const allEnchants = getAllEnchants(item);

    for (const configItem of sorted) {
        if (item.name !== configItem.name) continue;
        if (!loreMatchesConfig(item, configItem)) continue;

        const requiredEffects = configItem.effects || [];
        const enchantsOk = requiredEffects.every((required) => {
            const found = allEnchants.find((e) => e?.name === required.name);
            return found && found.lvl >= required.lvl;
        });
        if (!enchantsOk) continue;
        if (hasForbiddenEnchant(allEnchants, getForbiddenEffectNames(configItem), requiredEffects)) continue;

        return configItem;
    }
    return null;
}

/**
 * @param {object|null} item — слот из bot.inventory.slots[i]
 * @param {object[]} itemPrices — каталог с ценами (из оркестратора)
 * @param {string|null} goType — тип бота из bots.json
 * @returns {null|{ isTrash: true }|{ id, sellPrice, buyPrice, nacenka }}
 */
export function getSlotInfo(item, itemPrices, goType) {
    if (!item) return null;

    try {
        const cfg = findMatchingConfigItem(item, itemPrices, goType);
        if (!cfg) return { isTrash: true };

        if (typeof cfg.priceSell !== 'number' || Number.isNaN(cfg.priceSell)) {
            throw new Error(`нет priceSell у ${cfg.id ?? '?'}`);
        }

        const sellPrice = priceWithDurability(cfg.priceSell, getDurabilityPercent(item));
        if (!sellPrice) return { isTrash: true };

        const nacenka = cfg.nacenka ?? 0;
        if (typeof nacenka !== 'number' || Number.isNaN(nacenka)) {
            throw new Error(`нет nacenka у ${cfg.id}`);
        }

        return {
            id: cfg.id,
            sellPrice,
            buyPrice: sellPrice - nacenka,
            nacenka,
        };
    } catch (err) {
        const name = item?.name ?? '?';
        throw new Error(`${name}: ${err.message}`);
    }
}

function extractStrings(node, out) {
    if (node == null) return;
    if (Array.isArray(node)) {
        for (const item of node) extractStrings(item, out);
        return;
    }
    if (typeof node === 'object') {
        if (node.type === 'string' && Object.prototype.hasOwnProperty.call(node, 'value')) {
            const val = node.value;
            if (typeof val === 'string') out.push(val);
            else extractStrings(val, out);
        } else {
            for (const val of Object.values(node)) extractStrings(val, out);
        }
        return;
    }
    if (typeof node === 'string') out.push(node);
}

/** UUID лота на аукционе (auctions:if-uuid) */
export function getItemUUID(item) {
    const customDataComp = item?.components?.find((c) => c?.type === 'custom_data');
    if (!customDataComp) return null;

    const pubBukkit = customDataComp.data?.value?.PublicBukkitValues?.value;
    if (!pubBukkit) return null;

    const uuidArray = pubBukkit['auctions:if-uuid']?.value;
    if (!Array.isArray(uuidArray)) return null;

    return uuidArray.join(',');
}

/** Цена с лора лота на аукционе */
export function getPriceFromAhItem(item) {
    const loreComp = item?.components?.find((c) => c?.type === 'lore');
    if (!loreComp || !Array.isArray(loreComp.data)) {
        throw new Error(`нет лора для ${item?.name ?? '?'}`);
    }

    for (const loreEntry of loreComp.data) {
        const strings = [];
        extractStrings(loreEntry, strings);

        if (!strings.some((s) => typeof s === 'string' && s.includes('Цен'))) continue;

        for (const s of strings) {
            if (typeof s !== 'string') continue;
            const trimmed = s.trim();
            if (!trimmed) continue;

            const withoutCommas = trimmed.replace(/,/g, '');
            if (/^\d*\.?\d+$/.test(withoutCommas)) {
                const num = parseFloat(withoutCommas);
                if (!Number.isNaN(num)) {
                    if (num > 20000) return num;
                    throw new Error(`подозрительная цена ${num} для ${item?.name ?? '?'}`);
                }
            }
        }
    }

    throw new Error(`не удалось извлечь цену для ${item?.name ?? '?'}`);
}
