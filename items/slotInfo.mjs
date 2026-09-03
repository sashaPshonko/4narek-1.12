import {
    normalizeFuntimeEnchantName,
    refreshFuntimeEnchantNames,
    resolveFuntimeEnchantId,
} from './funtime-enchants.mjs';
import { catalogTypeMatchesGoType } from '../lib/go-type.mjs';

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

/** FunTime numeric id — см. ./funtime-enchants.mjs */
export function setEnchantRegistry() {
    refreshFuntimeEnchantNames();
}

/** Ваниль → minecraft:*, кастом (poison) без префикса. */
export function normalizeEnchantName(name) {
    return normalizeFuntimeEnchantName(name);
}

function resolveEnchantId(id) {
    return resolveFuntimeEnchantId(id);
}

function enchantNamesMatch(a, b) {
    return normalizeEnchantName(a) === normalizeEnchantName(b);
}

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
    'Опытный': 'skilled',
    'Попрыгун': 'jumping',
    'Снайпер': 'sniper',
    'Окисление': 'oxidation',
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
    const allowedByConfig = (configEffects || [])
        .map((e) => normalizeEnchantName(e?.name))
        .filter(Boolean);
    const forbiddenNorm = forbiddenList.map((n) => normalizeEnchantName(n));
    return allEnchants.some((enchant) => {
        if (!enchant?.name) return false;
        const name = normalizeEnchantName(enchant.name);
        if (allowedByConfig.some((a) => a === name)) return false;
        return forbiddenNorm.includes(name);
    });
}

/** Уровень чара строго выше потолка (яд III не в корзину «только яд II») */
function exceedsMaxEffectLevels(allEnchants, maxEffects = []) {
    if (!maxEffects?.length) return false;
    return maxEffects.some((cap) => {
        if (!cap?.name) return false;
        const found = allEnchants.find((e) => enchantNamesMatch(e?.name, cap.name));
        return found && found.lvl > cap.lvl;
    });
}

function getMaxEffectLevels(configItem) {
    const raw = configItem?.max_effects ?? configItem?.maxEffects;
    return Array.isArray(raw) ? raw : [];
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
    const out = [];
    const hasComponentEnchants = item?.components?.some(
        (c) => c.type === 'enchantments' || c.type === 'stored_enchantments',
    );

    if (!hasComponentEnchants && Array.isArray(item?.enchants) && item.enchants.length) {
        for (const e of item.enchants) {
            const name = resolveEnchantId(e.id ?? e.name);
            const lvl = e.lvl ?? e.level ?? 1;
            if (name) out.push({ name, lvl });
        }
    }

    const enchComponent = item?.components?.find((c) => c?.type === 'enchantments');
    const enchList = enchComponent?.data?.enchantments;
    if (Array.isArray(enchList)) {
        for (const e of enchList) {
            if (!e) continue;
            const name = resolveEnchantId(e.id ?? e.name);
            if (!name) continue;
            out.push({ name, lvl: e.level ?? e.lvl ?? 1 });
        }
    } else if (enchComponent?.data && typeof enchComponent.data === 'object') {
        for (const [k, v] of Object.entries(enchComponent.data)) {
            if (k === 'showInTooltip' || k === 'enchantments') continue;
            const name = resolveEnchantId(k);
            const lvl = typeof v === 'number' ? v : v?.lvl ?? v?.level;
            if (name && typeof lvl === 'number') out.push({ name, lvl });
        }
    }

    const storedList = item?.components?.find((c) => c?.type === 'stored_enchantments')?.data
        ?.enchantments;
    if (Array.isArray(storedList)) {
        for (const e of storedList) {
            const name = resolveEnchantId(e.id ?? e.name);
            const lvl = e.level ?? e.lvl;
            if (name && typeof lvl === 'number') out.push({ name, lvl });
        }
    }

    return out;
}

function getAllEnchants(item) {
    const byName = new Map();
    const custom = extractCustomEnchantsFromItem(item).map((ench) => {
        const englishName = customNameMap[ench.name];
        return englishName ? { name: englishName, lvl: ench.lvl } : ench;
    });
    for (const e of [...getVanillaEnchants(item), ...custom]) {
        if (!e?.name) continue;
        const name = normalizeEnchantName(e.name);
        const prev = byName.get(name);
        if (!prev || e.lvl > prev.lvl) byName.set(name, { name, lvl: e.lvl });
    }
    return [...byName.values()];
}

export { getAllEnchants };

function catalogCandidates(itemPrices) {
    if (!Array.isArray(itemPrices)) {
        throw new Error(`itemPrices не массив (${typeof itemPrices})`);
    }
    return itemPrices.filter((c) => c?.id?.endsWith('1.21'));
}

function itemMatchesConfigEntry(item, configItem, allEnchants) {
    if (item.name !== configItem.name) return false;
    if (!loreMatchesConfig(item, configItem)) return false;

    const requiredEffects = configItem.effects || [];
    const enchantsOk = requiredEffects.every((required) => {
        const found = allEnchants.find((e) => enchantNamesMatch(e?.name, required.name));
        return found && found.lvl >= required.lvl;
    });
    if (!enchantsOk) return false;
    if (hasForbiddenEnchant(allEnchants, getForbiddenEffectNames(configItem), requiredEffects)) {
        return false;
    }
    if (exceedsMaxEffectLevels(allEnchants, getMaxEffectLevels(configItem))) {
        return false;
    }
    return true;
}

function collectItemChatTexts(item) {
    const texts = [];
    const nameComp = item?.components?.find((c) => c?.type === 'custom_name');
    if (nameComp) collectChatTextLeaves(nameComp.data, texts);
    const loreComp = item?.components?.find((c) => c?.type === 'lore');
    if (loreComp) collectChatTextLeaves(loreComp.data, texts);
    for (const extra of [item?.customName, item?.displayName]) {
        if (typeof extra === 'string') texts.push(extra);
        else if (extra && typeof extra === 'object') collectChatTextLeaves(extra, texts);
    }
    return texts;
}

/** Только содержимое text/value, без ключей type: compound|string|list. */
function collectChatTextLeaves(node, out) {
    if (node == null) return;
    if (Array.isArray(node)) {
        for (const x of node) collectChatTextLeaves(x, out);
        return;
    }
    if (typeof node !== 'object') return;
    if (typeof node.text === 'string') {
        if (node.text) out.push(node.text);
    } else if (typeof node.text?.value === 'string') {
        if (node.text.value) out.push(node.text.value);
    } else if (node.type === 'string') {
        if (typeof node.value === 'string' && node.value) out.push(node.value);
        else if (Array.isArray(node.value)) {
            for (const s of node.value) {
                if (typeof s === 'string' && s) out.push(s);
            }
        }
    }
    for (const [k, v] of Object.entries(node)) {
        if (k === 'type' || k === 'text') continue;
        if (node.type === 'string' && k === 'value') continue;
        collectChatTextLeaves(v, out);
    }
}

/** FunTime режет «Шлем Крушителя» по extra.text (К+ру+ш+…). Смотрим склейку, не куски. */
export function flattenItemChatText(item) {
    return collectItemChatTexts(item)
        .map((s) => String(s))
        .filter((s) => s && !/^#/.test(s))
        .join('');
}

/**
 * Сет крушителя: имя после склейки («…Крушителя…»).
 * Переименованные лоты: в лоре «Оригинальный предмет» (у наших AH этого нет).
 */
export function isFunTimeCrusherItem(item) {
    if (!item) return false;
    const blob = flattenItemChatText(item);
    if (/крушител/i.test(blob)) return true;
    return /оригинальн.*предмет/i.test(blob);
}

/** Лучший id по num среди всего каталога (все go-типы). */
export function findBestMatchingConfigItem(item, catalogAll) {
    if (!item || isFunTimeCrusherItem(item)) return null;
    const candidates = catalogCandidates(catalogAll);
    if (!candidates.length) return null;

    const sorted = [...candidates].sort((a, b) => b.num - a.num);
    const allEnchants = getAllEnchants(item);

    for (const configItem of sorted) {
        if (itemMatchesConfigEntry(item, configItem, allEnchants)) return configItem;
    }
    return null;
}

/**
 * Матч для бота: лучший по num id должен быть своего goType.
 * @param {string|null} ownerGoType — go-тип бота; если задан и лучший id чужой — null
 * @returns {{ cfg: object, foreign: boolean } | null}
 */
export function findMatchingConfigItemResult(item, catalogAll, ownerGoType) {
    const best = findBestMatchingConfigItem(item, catalogAll);
    if (!best) return null;
    if (ownerGoType && !catalogTypeMatchesGoType(best.type, ownerGoType, best.name)) {
        return { cfg: best, foreign: true };
    }
    return { cfg: best, foreign: false };
}

export function findMatchingConfigItem(item, catalogAll, ownerGoType) {
    const hit = findMatchingConfigItemResult(item, catalogAll, ownerGoType);
    if (!hit || hit.foreign) return null;
    return hit.cfg;
}

/** Свой торгуемый лот (не мусор и не чужая категория). */
export function isBotTradeItem(info) {
    return Boolean(info && info.id && !info.isTrash && !info.isForeignCategory);
}

/**
 * @param {object|null} item — слот из bot.inventory.slots[i]
 * @param {object[]} catalogAll — полный каталог с ценами (все go-типы)
 * @param {string|null} goType — go-тип бота из bots.json
 * @returns {null|{ isTrash: true }|{ isForeignCategory: true, id?, foreignType? }|{ id, sellPrice, buyPrice, nacenka }}
 */
export function getSlotInfo(item, catalogAll, goType) {
    if (!item) return null;

    try {
        const hit = findMatchingConfigItemResult(item, catalogAll, goType);
        if (!hit) return { isTrash: true };

        // Чужая категория каталога: не покупаем, но не мусор (не дропать / не снимать с АХ).
        if (hit.foreign) {
            return {
                isForeignCategory: true,
                id: hit.cfg.id,
                foreignType: hit.cfg.type,
            };
        }

        const cfg = hit.cfg;
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

/** FunTime мешает латиницу в «Цена» (Ценa / Цeна). */
function loreLooksLikePriceLabel(s) {
    const n = String(s)
        .toLowerCase()
        .replace(/a/g, 'а')
        .replace(/e/g, 'е')
        .replace(/o/g, 'о')
        .replace(/p/g, 'р')
        .replace(/c/g, 'с')
        .replace(/x/g, 'х')
        .replace(/y/g, 'у');
    return n.includes('цен');
}

/** «$2,500,000» / « 2.500.000» → число. Цвета #RRGGBB игнорируем. */
function parseAhPriceNumber(s) {
    if (typeof s !== 'string') return null;
    const trimmed = s.trim();
    if (!trimmed || /^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return null;
    // нужен хотя бы один признак цены: $ или разрядная запятая/пробел в числе
    const looksLikeMoney =
        trimmed.includes('$') ||
        /\d,\d{3}/.test(trimmed) ||
        /\d\s\d{3}/.test(trimmed);
    if (!looksLikeMoney && !/^\d[\d\s.,]*$/.test(trimmed)) return null;

    const cleaned = trimmed.replace(/[^\d.]/g, '');
    if (!cleaned || cleaned === '.') return null;
    let normalized = cleaned;
    const dotCount = (cleaned.match(/\./g) || []).length;
    if (dotCount > 1) normalized = cleaned.replace(/\./g, '');
    const num = parseFloat(normalized);
    if (Number.isNaN(num)) return null;
    return num;
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

/** Цена с лора лота на аукционе. ≤ этой — клик 5–10 с (фейк-слот), не скип. */
export const AH_FAKE_SLOT_PRICE_MAX = 150000;
export function getPriceFromAhItem(item) {
    const loreComp = item?.components?.find((c) => c?.type === 'lore');
    if (!loreComp || !Array.isArray(loreComp.data)) {
        throw new Error(`нет лора для ${item?.name ?? '?'}`);
    }

    for (const loreEntry of loreComp.data) {
        const strings = [];
        extractStrings(loreEntry, strings);

        if (!strings.some((s) => typeof s === 'string' && loreLooksLikePriceLabel(s))) continue;

        const candidates = [];
        for (const s of strings) {
            if (typeof s !== 'string') continue;
            const num = parseAhPriceNumber(s);
            if (num == null) continue;
            const score =
                (s.includes('$') ? 4 : 0) +
                (/\d,\d{3}/.test(s) ? 2 : 0) +
                (num > 150000 ? 1 : 0);
            candidates.push({ num, score });
        }
        if (!candidates.length) continue;

        candidates.sort((a, b) => b.score - a.score || b.num - a.num);
        const best = candidates[0].num;
        // ≤150k: FunTime так почти не выставляет (фейк-слот). Цену отдаём, скип — в getBestAHSlot / медленный клик.
        return best;
    }

    throw new Error(`не удалось извлечь цену для ${item?.name ?? '?'}`);
}

/** Книга АХ: битые лоты не пишем — продавцы часто ставят цену как у целых. */
export const AH_BOOK_MIN_DURABILITY = 0.9;

function loreLooksLikeSellerLabel(s) {
    const n = String(s)
        .toLowerCase()
        .replace(/a/g, 'а')
        .replace(/e/g, 'е')
        .replace(/o/g, 'о')
        .replace(/p/g, 'р')
        .replace(/c/g, 'с');
    return n.includes('продавец');
}

/** Ник из лора («Продавец:» + extra «Beyermy»). */
export function getAhSellerNick(item) {
    const loreComp = item?.components?.find((c) => c?.type === 'lore');
    if (!loreComp || !Array.isArray(loreComp.data)) return '';
    const found = [];
    walkSellerNick(loreComp.data, found);
    return found[0] || '';
}

function looksLikeMcNick(t) {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(t)) return false;
    const low = t.toLowerCase();
    if (low === 'string' || low === 'compound' || low === 'list' || low === 'byte' || low === 'int') {
        return false;
    }
    return true;
}

function collectLoreTextValues(node, out) {
	if (node == null) return;
	if (typeof node === 'string') {
		out.push(node);
		return;
	}
	if (Array.isArray(node)) {
		for (const x of node) collectLoreTextValues(x, out);
		return;
	}
	if (typeof node !== 'object') return;
	// FunTime: extra.value = { type: 'string', value: ['psychowhore'] }
	if (node.type === 'string' && Array.isArray(node.value)) {
		for (const s of node.value) {
			if (typeof s === 'string') out.push(s);
		}
		return;
	}
	if (typeof node.text === 'string') out.push(node.text);
	else if (typeof node.text?.value === 'string') out.push(node.text.value);
	for (const v of Object.values(node)) collectLoreTextValues(v, out);
}

function walkSellerNick(node, found) {
    if (found.length || node == null) return;
    if (Array.isArray(node)) {
        for (const x of node) walkSellerNick(x, found);
        return;
    }
    if (typeof node !== 'object') return;
    const label = node.text?.value ?? node.text;
    if (typeof label === 'string' && loreLooksLikeSellerLabel(label)) {
        const extra = node.extra?.value?.value ?? node.extra;
        const names = [];
        collectLoreTextValues(extra, names);
        const nick = names.map((s) => String(s).trim()).find((t) => looksLikeMcNick(t));
        if (nick) {
            found.push(nick);
            return;
        }
    }
    for (const v of Object.values(node)) walkSellerNick(v, found);
}

const ahBookArmorNames = new Set([
    'netherite_helmet',
    'netherite_chestplate',
    'netherite_leggings',
    'netherite_boots',
]);

function itemHasMending(item) {
    return getAllEnchants(item).some((e) => normalizeEnchantName(e?.name) === 'minecraft:mending');
}

/** Книга АХ: броня с починкой не шлём в Go (матч закупа не трогаем). */
export function skipAhBookArmorMending(item, cfg) {
    if (!cfg || !ahBookArmorNames.has(cfg.name)) return false;
    return itemHasMending(item);
}

/**
 * Лот в книгу: матч по зачарам конфига, цена любая (в т.ч. дороже нашего buy).
 * @returns {null|{ uuid, go_type, item_id, price, durability, seller, enchants }}
 */
export function describeAhBookLot(item, catalogAll) {
    if (!item) return null;
    const uuid = getItemUUID(item);
    if (!uuid) return null;
    const durability = getDurabilityPercent(item);
    if (durability < AH_BOOK_MIN_DURABILITY) return null;
    const cfg = findBestMatchingConfigItem(item, catalogAll);
    if (!cfg?.id || !cfg.type) return null;
    if (skipAhBookArmorMending(item, cfg)) return null;
    let price;
    try {
        price = getPriceFromAhItem(item);
    } catch {
        return null;
    }
    if (!Number.isFinite(price) || price <= AH_FAKE_SLOT_PRICE_MAX) return null;
    return {
        uuid,
        go_type: cfg.type,
        item_id: cfg.id,
        price: Math.round(price),
        durability: Math.round(durability * 1000) / 1000,
        seller: getAhSellerNick(item),
        enchants: getAllEnchants(item),
    };
}

/** Слоты окна АХ → лоты в книгу (без своих ников). extraItem — лот, который кликаем. */
export function collectAhBookLots(windowSlots, firstSlot, lastSlot, catalogAll, { skipSeller, extraItem } = {}) {
    const lots = [];
    const seen = new Set();
    const me = String(skipSeller || '').trim().toLowerCase();
    const push = (item) => {
        if (!item) return;
        let lot;
        try {
            lot = describeAhBookLot(item, catalogAll);
        } catch {
            return;
        }
        if (!lot?.uuid || seen.has(lot.uuid)) return;
        if (lot.seller && lot.seller.trim().toLowerCase() === me) return;
        seen.add(lot.uuid);
        lots.push(lot);
    };
    if (windowSlots) {
        for (let slot = firstSlot; slot <= lastSlot; slot++) {
            push(windowSlots[slot]);
        }
    }
    push(extraItem);
    return lots;
}
