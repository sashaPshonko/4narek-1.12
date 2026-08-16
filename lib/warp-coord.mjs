import { pickWarp } from './warp-pick.mjs';

const DEFAULT_CLAIM_TTL_MS = 130_000;

/**
 * Координатор варпов на одной анархии (один оркестратор = одна анка).
 * Не даёт нескольким ботам одновременно идти на один и тот же варп.
 */
export function createWarpCoordinator({ claimTtlMs = DEFAULT_CLAIM_TTL_MS } = {}) {
    /** @type {Map<string, { warp: string, until: number }>} */
    const claims = new Map();

    function cleanup(now = Date.now()) {
        for (const [username, claim] of claims) {
            if (claim.until <= now) claims.delete(username);
        }
    }

    function occupancy(excludeUsername, now = Date.now()) {
        cleanup(now);
        /** @type {Record<string, number>} */
        const counts = {};
        for (const [username, claim] of claims) {
            if (username === excludeUsername) continue;
            counts[claim.warp] = (counts[claim.warp] || 0) + 1;
        }
        return counts;
    }

    function claim(username, warp, now = Date.now()) {
        claims.set(username, { warp, until: now + claimTtlMs });
    }

    function release(username) {
        claims.delete(username);
    }

    function handlePick({ username, anarchy, lastWarp = null, nowMs = Date.now() }) {
        const occ = occupancy(username, nowMs);
        const warp = pickWarp({
            username,
            anarchy,
            lastWarp,
            occupancy: occ,
            nowMs,
        });
        claim(username, warp, nowMs);
        return warp;
    }

    return { handlePick, release, claim, occupancy, cleanup };
}
