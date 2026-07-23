/** Локальные id листинга (последняя цифра цены 0–4): до 5 лотов на АХ у бота. */

export const LISTING_ID_COUNT = 5;

/**
 * @typedef {{ listingId: number, catalogId: string, enchants: {name: string, lvl: number}[], durability: number, price: number }} ListingMeta
 */

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
        /** Цены лотов из слотов 0–4 хранилища → занятые id; память без лота на АХ чистим. */
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

        /** Свободный id 0..4 или null если все заняты. */
        allocId() {
            for (let id = 0; id < LISTING_ID_COUNT; id++) {
                if (!isBusy(id)) return id;
            }
            return null;
        },

        /** Каталожная sell-цена → цена с последней цифрой = listingId. */
        priceWithListingId(basePrice, listingId) {
            const base = Math.floor(Number(basePrice));
            if (!Number.isFinite(base) || base <= 0) return NaN;
            return Math.floor(base / 10) * 10 + (listingId % 10);
        },

        /** Каталог vs цена на АХ: игнор последней цифры (listing id). */
        pricesMatch(ahPrice, catalogSellPrice) {
            if (!Number.isFinite(ahPrice) || !Number.isFinite(catalogSellPrice)) return false;
            return Math.floor(ahPrice / 10) === Math.floor(catalogSellPrice / 10);
        },

        setPending(meta) {
            pending = meta;
        },

        clearPending() {
            pending = null;
        },

        getPending() {
            return pending;
        },

        /**
         * Подтверждение «выставлен на продажу за X».
         * @returns {ListingMeta | null}
         */
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

        /**
         * «У вас купили» — достать и освободить id.
         * @returns {ListingMeta | null}
         */
        takeSold(price) {
            if (!Number.isFinite(price)) return null;
            const id = price % 10;
            const row = memory.get(id) ?? null;
            if (row) memory.delete(id);
            return row;
        },
    };
}
