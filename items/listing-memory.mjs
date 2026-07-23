/** Локальные id листинга (последняя цифра цены 0–4): до 5 лотов на АХ у бота. */

export const LISTING_ID_COUNT = 5;

/**
 * @typedef {{ listingId: number, catalogId: string, enchants: {name: string, lvl: number}[], durability: number|null, price: number }} ListingMeta
 */

/** Каталог vs цена на АХ: игнор последней цифры (listing id). */
export function pricesMatch(ahPrice, catalogSellPrice) {
    if (!Number.isFinite(ahPrice) || !Number.isFinite(catalogSellPrice)) return false;
    return Math.floor(ahPrice / 10) === Math.floor(catalogSellPrice / 10);
}

/** Каталожная sell-цена → цена с последней цифрой = listingId. */
export function priceWithListingId(basePrice, listingId) {
    const base = Math.floor(Number(basePrice));
    if (!Number.isFinite(base) || base <= 0) return NaN;
    return Math.floor(base / 10) * 10 + (listingId % 10);
}

export function createListingMemory() {
    /** @type {Map<number, ListingMeta>} */
    const memory = new Map();
    /** @type {ListingMeta | null} */
    let pending = null;
    /** @type {Set<number>} */
    let occupiedFromScan = new Set();

    function isBusy(id) {
        return occupiedFromScan.has(id) || memory.has(id) || pending?.listingId === id;
    }

    return {
        syncFromStoragePrices(prices) {
            occupiedFromScan = new Set();
            for (const p of prices) {
                if (!Number.isFinite(p) || p <= 0) continue;
                occupiedFromScan.add(p % 10);
            }
            for (const id of [...memory.keys()]) {
                if (!occupiedFromScan.has(id)) memory.delete(id);
            }
        },

        allocId() {
            for (let id = 0; id < LISTING_ID_COUNT; id++) {
                if (!isBusy(id)) return id;
            }
            return null;
        },

        priceWithListingId,
        pricesMatch,

        setPending(meta) {
            pending = meta;
        },

        clearPending() {
            pending = null;
        },

        getPending() {
            return pending;
        },

        confirmPending(price) {
            if (!pending || !Number.isFinite(price)) return null;
            if (price % 10 !== pending.listingId) {
                pending = null;
                return null;
            }
            const row = { ...pending, price };
            memory.set(pending.listingId, row);
            pending = null;
            return row;
        },

        takeSold(price) {
            if (!Number.isFinite(price)) return null;
            const id = price % 10;
            const row = memory.get(id) ?? null;
            if (row) memory.delete(id);
            return row;
        },

        exportState() {
            return {
                pending,
                occupied: [...occupiedFromScan],
                listings: [...memory.entries()].map(([listingId, row]) => ({
                    listingId,
                    catalogId: row.catalogId,
                    enchants: row.enchants || [],
                    durability: row.durability ?? null,
                    price: row.price,
                })),
            };
        },

        importState(raw) {
            memory.clear();
            pending = null;
            occupiedFromScan = new Set();
            if (!raw || typeof raw !== 'object') return;
            for (const id of raw.occupied || []) {
                if (Number.isFinite(id)) occupiedFromScan.add(Number(id) % 10);
            }
            for (const row of raw.listings || []) {
                const listingId = Number(row?.listingId);
                if (!Number.isFinite(listingId) || !row?.catalogId) continue;
                memory.set(listingId % 10, {
                    listingId: listingId % 10,
                    catalogId: String(row.catalogId),
                    enchants: Array.isArray(row.enchants) ? row.enchants : [],
                    durability: row.durability ?? null,
                    price: Number(row.price) || 0,
                });
            }
            if (raw.pending?.catalogId != null && Number.isFinite(Number(raw.pending.listingId))) {
                pending = {
                    listingId: Number(raw.pending.listingId) % 10,
                    catalogId: String(raw.pending.catalogId),
                    enchants: Array.isArray(raw.pending.enchants) ? raw.pending.enchants : [],
                    durability: raw.pending.durability ?? null,
                    price: Number(raw.pending.price) || 0,
                };
            }
        },
    };
}
