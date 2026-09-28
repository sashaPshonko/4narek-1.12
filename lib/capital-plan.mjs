import { clanKeepSum } from './clan-save-sum.mjs';

/**
 * Orch capital plan: equal cash share across alive bots + buy cap.
 *
 * @param {{
 *   balances: Array<{ username: string, balance: number }>,
 *   treasury?: number|null,
 *   catalog?: Array<{ priceSell?: number }>,
 *   clanMates?: number,
 * }} opts
 * @returns {{
 *   keepSum: number|null,
 *   maxBuyPrice: number|null,
 *   fair: number|null,
 *   mates: number,
 *   liquid: number,
 *   source: 'ledger'|'fallback',
 * }}
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

    if (!alive.length) {
        let best = 0;
        for (const entry of catalog || []) {
            const p = entry?.priceSell;
            if (typeof p === 'number' && Number.isFinite(p) && p > best) best = p;
        }
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
    // Делим на clanMates из bots.json, даже если часть ещё не репортнула баланс (считаем 0).
    const n = Math.max(alive.length, matesFallback);
    const fair = liquid / n;
    const keepSum = Math.floor(fair);
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
