/** Единый go-тип: шлем / нагрудник / штаны / ботинки (без позорной). */
export const NETHERITE_ARMOR_GO_TYPE = 'netherite_armor-1.21';

export const NETHERITE_ARMOR_CATALOG_TYPES = new Set([
    'netherite_helmet-1.21',
    'netherite_chestplate-1.21',
    'netherite_leggings-1.21',
    'netherite_boots-1.21',
]);

/** @param {string|null|undefined} catalogType @param {string|null|undefined} goType */
export function catalogTypeMatchesGoType(catalogType, goType) {
    if (!goType) return true;
    if (catalogType === goType) return true;
    if (goType === NETHERITE_ARMOR_GO_TYPE) {
        return NETHERITE_ARMOR_CATALOG_TYPES.has(catalogType);
    }
    return false;
}
