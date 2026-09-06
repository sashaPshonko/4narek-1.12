/** Per-bot desync: старт воркеров и профиль темпа АХ. */

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
 * Пауза перед стартом следующего воркера (не все сразу).
 * ~2–7 с + лёгкий сдвиг от ника.
 */
export function botStartGapMs(username, index = 0) {
    const h = hashUsername(username);
    const base = 2000 + (h % 4000); // 2–6 с от ника
    const wave = (index % 3) * rndInt(400, 1200); // чуть развести соседние
    return base + wave;
}

export function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * Поднять недостающих воркеров с паузой между стартами.
 */
export async function runWorkersStaggered({
    bots,
    workers,
    pendingRestarts,
    runWorker,
    log = console.log,
}) {
    let started = 0;
    for (const bot of bots.values()) {
        if (bot.banned || bot.authFault) continue;
        const live = workers.get(bot.username);
        if (live?.worker) continue;
        if (pendingRestarts?.has?.(bot.username)) continue;

        if (started > 0) {
            const gap = botStartGapMs(bot.username, started);
            log(`⏳ desync старт ${bot.username} через ${(gap / 1000).toFixed(1)}с`);
            await sleep(gap);
        }
        await runWorker(bot);
        started++;
    }
    return started;
}

/** Профиль кликов АХ — у каждого ника свой шаг/джиттер. */
export function createAhTempoProfile(username) {
    const h = hashUsername(username);
    const stepMin = 850 + (h % 450); // 850–1299
    const stepSpan = 350 + ((h >> 3) % 550); // 350–899
    const stepMax = stepMin + stepSpan;
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
