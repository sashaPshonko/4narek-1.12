/**
 * Рабочий кэш на руках из пула 5× самого дорогого лота категории.
 * 1× top всегда свой (можно купить без казны) + остаток пула поровну на соклановцев.
 *
 * n=1 → 5×top (как раньше)
 * n=3 → ≈2.33×top
 */
export function clanKeepSum(bestPrice, clanMates = 1) {
    if (typeof bestPrice !== 'number' || !Number.isFinite(bestPrice) || bestPrice <= 0) {
        return null;
    }
    const n = Math.max(1, Math.floor(Number(clanMates) || 1));
    return Math.ceil(bestPrice * (1 + 4 / n));
}
