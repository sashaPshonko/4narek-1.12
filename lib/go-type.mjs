/** Единый go-тип: шлем / нагрудник / штаны / ботинки (без позорной). */
export const NETHERITE_ARMOR_GO_TYPE = 'netherite_armor-1.21';

/** legacy goType на анках 508/509 — матч по name в каталоге */
export const PIECE_GO_TYPE_TO_NAME = {
    'netherite_helmet-1.21': 'netherite_helmet',
    'netherite_chestplate-1.21': 'netherite_chestplate',
    'netherite_leggings-1.21': 'netherite_leggings',
    'netherite_boots-1.21': 'netherite_boots',
};

/**
 * @param {string|null|undefined} catalogType
 * @param {string|null|undefined} goType
 * @param {string|null|undefined} [catalogName]
 */
export function catalogTypeMatchesGoType(catalogType, goType, catalogName) {
    if (!goType) return true;
    if (catalogType === goType) return true;
    if (catalogType !== NETHERITE_ARMOR_GO_TYPE) return false;
    if (goType === NETHERITE_ARMOR_GO_TYPE) return true;
    const wantName = PIECE_GO_TYPE_TO_NAME[goType];
    return Boolean(wantName && catalogName === wantName);
}
