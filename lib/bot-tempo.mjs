/** Per-bot desync + глобальный Go launch-gate. */

import { awaitFleetLaunchGrant, cancelFleetLaunch } from './fleet-launch-gate.mjs';

export function hashUsername(username) {
    const s = String(username || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function rndInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * Локальный микро-разброс только для refill (Go уже сериализует флот).
 * Cold: без локальной минуты — ждём только Go grant.
 */
export function botStartGapMs(username, index = 0, { cold = false } = {}) {
    const h = hashUsername(username);
    if (cold) return 0;
    const base = 2000 + (h % 4000);
    const wave = (index % 3) * rndInt(400, 1200);
    return base + wave;
}

export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Поднять недостающих воркеров: очередь Go → grant → runWorker.
 */
export async function runWorkersStaggered({
    bots,
    workers,
    pendingRestarts,
    runWorker,
    log = console.log,
}) {
    let liveCount = 0;
    for (const bot of bots.values()) {
        if (workers.get(bot.username)?.worker) liveCount++;
    }
    const cold = liveCount === 0;

    let started = 0;
    for (const bot of bots.values()) {
        if (bot.banned || bot.authFault) continue;
        const live = workers.get(bot.username);
        if (live?.worker) continue;
        if (pendingRestarts?.has?.(bot.username)) continue;

        if (!cold && started > 0) {
            const gap = botStartGapMs(bot.username, started, { cold: false });
            if (gap > 0) {
                log(`⏳ desync refill ${bot.username} через ${(gap / 1000).toFixed(1)}с`);
                await sleep(gap);
            }
        }

        const ok = await awaitFleetLaunchGrant({
            username: bot.username,
            anarchy: bot.anarchy,
            kind: 'bot',
            log,
        });
        if (!ok) {
            log(`[launch-gate] skip start ${bot.username}`);
            continue;
        }
        if (bot.banned || bot.authFault) {
            await cancelFleetLaunch({ username: bot.username, anarchy: bot.anarchy, log });
            continue;
        }
        await runWorker(bot);
        started++;
    }
    return started;
}

/** Профиль кликов АХ — у каждого ника свой шаг/джиттер. */
export function createAhTempoProfile(username) {
    const h = hashUsername(username);
    // step 500–1000: min 500–700, max = min + остаток до потолка 1000
    const stepMin = 500 + (h % 201); // 500–700
    const stepMax = Math.min(1000, stepMin + 200 + ((h >> 3) % 301)); // ≤1000, span ~200–500
    const glassMin = 350 + ((h >> 8) % 200);
    const glassMax = glassMin + 400 + ((h >> 12) % 400);
    const extraJitterMax = 150 + ((h >> 5) % 450); // 150–599 к каждому клику

    return {
        buyStep: { min: stepMin, max: stepMax },
        glass: { min: glassMin, max: glassMax },
        extraJitterMax,
        extraJitter() {
            return rndInt(0, extraJitterMax);
        },
    };
}
