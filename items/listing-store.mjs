/**
 * Listing memory на стороне оркестратора (переживает рестарт воркера).
 * Состояние на диск: listings-state/<username>.json
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createListingMemory, priceWithListingId } from './listing-memory.mjs';

/**
 * @param {string} stateDir
 */
export function createListingStore(stateDir) {
    mkdirSync(stateDir, { recursive: true });
    /** @type {Map<string, ReturnType<typeof createListingMemory>>} */
    const byUser = new Map();

    function pathFor(username) {
        const safe = String(username || 'unknown').replace(/[^\w.\-]+/g, '_');
        return join(stateDir, `${safe}.json`);
    }

    function load(username) {
        const key = String(username || '');
        if (byUser.has(key)) return byUser.get(key);
        const mem = createListingMemory();
        const p = pathFor(key);
        if (existsSync(p)) {
            try {
                mem.importState(JSON.parse(readFileSync(p, 'utf8')));
            } catch (e) {
                console.warn(`[listing] load ${key}: ${e.message}`);
            }
        }
        byUser.set(key, mem);
        return mem;
    }

    function save(username) {
        const key = String(username || '');
        const mem = byUser.get(key);
        if (!mem) return;
        try {
            writeFileSync(pathFor(key), JSON.stringify(mem.exportState(), null, 0));
        } catch (e) {
            console.warn(`[listing] save ${key}: ${e.message}`);
        }
    }

    /**
     * @param {string} username
     * @param {{ op: string, prices?: number[], sellPrice?: number, catalogId?: string, enchants?: any[], durability?: number|null, price?: number }} msg
     */
    function handle(username, msg) {
        const mem = load(username);
        let result = null;
        switch (msg.op) {
            case 'sync':
                mem.syncFromStoragePrices(msg.prices || []);
                result = { ok: true };
                break;
            case 'alloc': {
                const listingId = mem.allocId();
                if (listingId == null) {
                    result = { listingId: null, listPrice: null };
                    break;
                }
                const listPrice = priceWithListingId(msg.sellPrice, listingId);
                if (!Number.isFinite(listPrice)) {
                    result = { listingId: null, listPrice: null };
                    break;
                }
                mem.setPending({
                    listingId,
                    catalogId: String(msg.catalogId || ''),
                    enchants: Array.isArray(msg.enchants) ? msg.enchants : [],
                    durability: msg.durability ?? null,
                    price: listPrice,
                });
                result = { listingId, listPrice };
                break;
            }
            case 'clearPending':
                mem.clearPending();
                result = { ok: true };
                break;
            case 'confirm': {
                const row = mem.confirmPending(msg.price);
                result = row
                    ? {
                          catalogId: row.catalogId,
                          listingId: row.listingId,
                          price: row.price,
                          enchants: row.enchants,
                          durability: row.durability,
                      }
                    : null;
                break;
            }
            case 'takeSold': {
                const row = mem.takeSold(msg.price);
                result = row
                    ? {
                          catalogId: row.catalogId,
                          listingId: row.listingId,
                          price: row.price,
                          enchants: row.enchants,
                          durability: row.durability,
                      }
                    : null;
                break;
            }
            default:
                result = { error: `unknown_op:${msg.op}` };
        }
        save(username);
        return result;
    }

    return { handle, load, save };
}
