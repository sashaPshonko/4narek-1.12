import { clanKeepSum } from './clan-save-sum.mjs';

function bestCatalogPrice(catalog) {
    let best = 0;
    for (const entry of catalog || []) {
        const p = entry?.priceSell;
        if (typeof p === 'number' && Number.isFinite(p) && p > best) best = p;
    }
    return best;
}

/**
 * Orch capital plan: equal cash share across alive bots + buy cap.
 *
 * @param {{
 *   balances: Array<{ username: string, balance: number }>,
 *   treasury?: number|null,
 *   catalog?: Array<{ priceSell?: number }>,
 *   clanMates?: number,
 * }} opts
 */
export function computeCapitalPlan({
    balances = [],
    treasury = null,
    catalog = [],
    clanMates = 1,
} = {}) {
    const alive = [];
    for (const row of balances) {
        const bal = Number(row?.balance);
        if (!Number.isFinite(bal) || bal < 0) continue;
        const nick = String(row?.username || '').trim();
        if (!nick) continue;
        alive.push({ username: nick, balance: bal });
    }

    const trea = Number(treasury);
    const treasuryPart = Number.isFinite(trea) && trea > 0 ? trea : 0;
    const matesFallback = Math.max(1, Math.floor(Number(clanMates) || 1));
    const best = bestCatalogPrice(catalog);

    if (!alive.length) {
        const keep = clanKeepSum(best, matesFallback);
        return {
            keepSum: keep,
            maxBuyPrice: keep != null ? Math.floor(keep * 0.9) : null,
            fair: keep,
            mates: matesFallback,
            liquid: treasuryPart,
            source: 'fallback',
        };
    }

    const sumBal = alive.reduce((s, r) => s + r.balance, 0);
    const liquid = sumBal + treasuryPart;
    // Полный roster репортит → равная доля. Частичный → не ниже clanKeepSum (анти-спираль).
    const n = Math.max(alive.length, matesFallback);
    const fair = liquid / n;
    let keepSum = Math.floor(fair);
    if (alive.length < matesFallback) {
        const floorKeep = clanKeepSum(best, matesFallback);
        if (floorKeep != null) {
            keepSum = Math.max(keepSum, Math.min(floorKeep, Math.floor(liquid)));
        }
    }
    const maxBuyPrice = Math.max(0, Math.floor(fair * 0.9));

    return {
        keepSum,
        maxBuyPrice,
        fair,
        mates: n,
        liquid,
        source: 'ledger',
    };
}
