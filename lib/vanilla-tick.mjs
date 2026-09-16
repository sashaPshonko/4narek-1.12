/**
 * 20 TPS как у клиента: вместо setInterval(50) — абсолютный schedule
 * (nextAt += 50), без пачек catchup при лаге event loop.
 *
 * Ставить ДО createBot / login (import side-effect из vanilla-client).
 * Ловит setInterval из mineflayer/lib/plugins/physics.js.
 */

const TICK_MS = 50;

/**
 * @returns {boolean} true если хук уже/только что установлен
 */
export function installPrecisePhysicsTimer() {
    if (globalThis.__vanillaPrecisePhysicsTimer) return true;
    globalThis.__vanillaPrecisePhysicsTimer = true;

    const origSetInterval = global.setInterval.bind(global);
    const origClearInterval = global.clearInterval.bind(global);
    const origSetTimeout = global.setTimeout.bind(global);
    const origClearTimeout = global.clearTimeout.bind(global);

    /** @type {Map<object, { cleared: boolean, timeout: any, nextAt: number, token: any }>} */
    const precise = new Map();

    function isMineflayerPhysicsStack() {
        const s = new Error().stack || '';
        return s.includes('plugins/physics.js') || s.includes('plugins\\physics.js');
    }

    global.setInterval = function vanillaPreciseSetInterval(fn, ms, ...args) {
        if (ms === TICK_MS && typeof fn === 'function' && isMineflayerPhysicsStack()) {
            const state = {
                cleared: false,
                timeout: null,
                nextAt: performance.now(),
                token: null,
            };

            const tick = () => {
                if (state.cleared) return;
                try {
                    fn(...args);
                } catch (err) {
                    console.error('[vanilla-tick] physics error:', err?.message || err);
                }
                state.nextAt += TICK_MS;
                const now = performance.now();
                // Опоздали больше чем на полтика — resync, не догоняем пачкой
                if (state.nextAt < now - TICK_MS / 2) {
                    state.nextAt = now + TICK_MS;
                }
                const delay = Math.max(0, state.nextAt - performance.now());
                state.timeout = origSetTimeout(tick, delay);
            };

            state.timeout = origSetTimeout(tick, 0);
            // Token, который clearInterval от mineflayer сможет снять
            state.token = origSetInterval(() => {}, 2 ** 30);
            precise.set(state.token, state);
            return state.token;
        }
        return origSetInterval(fn, ms, ...args);
    };

    global.clearInterval = function vanillaPreciseClearInterval(token) {
        const state = precise.get(token);
        if (state) {
            state.cleared = true;
            if (state.timeout != null) origClearTimeout(state.timeout);
            precise.delete(token);
            return origClearInterval(token);
        }
        return origClearInterval(token);
    };

    return true;
}

// Авто-install при импорте модуля
installPrecisePhysicsTimer();
