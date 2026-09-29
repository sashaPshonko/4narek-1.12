/**
 * FunTime «Максимальная цена» — не рыночная и не книга.
 * Раньше бот делал set_max_price в Go и ронял весь SKU (почти-мега 2.9M → 890k).
 *
 * Если потолок FunTime сильно ниже нашей каталожной sell-цены — пропускаем слот,
 * в оркестратор не пишем. Близкий потолок (≥ ratio) — только needPrice на этот слот.
 */

/** Ниже этого доля от catalogSell — не верим FunTime, skip слот. */
export const FUNTIME_MAX_TRUST_RATIO = 0.9;

/**
 * @param {number} funtimeRaw — число из чата «Максимальная цена …»
 * @param {number} catalogSell — info.sellPrice (уже с прочностью)
 * @returns {{ ok: true, listPrice: number } | { ok: false, reason: string, listPrice: number }}
 */
export function decideFuntimeMaxPrice(funtimeRaw, catalogSell) {
    const raw = Number(funtimeRaw);
    const catalog = Number(catalogSell);
    if (!Number.isFinite(raw) || raw <= 0) {
        return { ok: false, reason: 'bad_funtime_max', listPrice: 0 };
    }
    if (!Number.isFinite(catalog) || catalog <= 0) {
        return { ok: false, reason: 'no_catalog', listPrice: raw };
    }

    const marker = catalog % 100;
    let listPrice = Math.floor(raw / 10000) * 10000 + marker;
    if (listPrice > raw) listPrice = Math.floor(raw / 10000) * 10000 - 100 + marker;
    if (listPrice <= 0) listPrice = raw;

    if (listPrice < catalog * FUNTIME_MAX_TRUST_RATIO) {
        return {
            ok: false,
            reason: `funtime_max ${listPrice} << catalog ${catalog} (<${Math.round(FUNTIME_MAX_TRUST_RATIO * 100)}%)`,
            listPrice,
        };
    }
    return { ok: true, listPrice };
}
