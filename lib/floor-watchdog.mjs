/**
 * Аварийный выход из падения: пока бот в АХ/продаже без WASD,
 * инерция от anti-AFK всё равно уносит в яму → смерть и дроп монет.
 * Ловим полёт вниз и варпаем на shop.
 */

import {
    clearWasd,
    isStandingOnFloor,
    horizSpeed,
} from './wasd-pit-guard.mjs';

const FALL_VY = -0.35;
const FALL_MS = 280;
const WARP_COOLDOWN_MS = 45_000;
const TICK_MS = 80;

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{
 *   log?: (msg: string) => void,
 *   warpCmd?: string,
 *   shouldIgnore?: () => boolean,
 * }} [opts]
 */
export function attachFloorWatchdog(bot, opts = {}) {
    if (!bot || bot.__floorWatchdogAttached) return;
    bot.__floorWatchdogAttached = true;

    const logFn = typeof opts.log === 'function' ? opts.log : () => {};
    const warpCmd = opts.warpCmd || '/warp shop';
    let offFloorSince = 0;
    let lastWarpAt = 0;
    let warping = false;

    const timer = setInterval(() => {
        try {
            if (typeof opts.shouldIgnore === 'function' && opts.shouldIgnore()) {
                offFloorSince = 0;
                return;
            }
            const ent = bot.entity;
            if (!ent?.position) {
                offFloorSince = 0;
                return;
            }
            // мёртв / нет HP — не спамим warp
            if (typeof bot.health === 'number' && bot.health <= 0) {
                offFloorSince = 0;
                return;
            }

            const onFloor = isStandingOnFloor(bot);
            const vy = ent.velocity?.y ?? 0;
            const falling = !onFloor && vy <= FALL_VY;

            if (!falling) {
                offFloorSince = 0;
                return;
            }

            if (!offFloorSince) offFloorSince = Date.now();
            if (Date.now() - offFloorSince < FALL_MS) return;
            if (warping) return;
            if (Date.now() - lastWarpAt < WARP_COOLDOWN_MS) return;

            warping = true;
            lastWarpAt = Date.now();
            clearWasd(bot);
            try {
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
            } catch {
                /* ignore */
            }
            const spd = horizSpeed(bot);
            logFn(
                `floor-watchdog → падение vy=${vy.toFixed(2)} spd=${Number.isFinite(spd) ? spd.toFixed(2) : '?'} → ${warpCmd}`,
            );
            try {
                bot.chat(warpCmd);
            } catch (err) {
                logFn(`floor-watchdog → chat fail: ${err?.message || err}`);
            }
            setTimeout(() => {
                warping = false;
                offFloorSince = 0;
            }, 8_000);
        } catch {
            /* ignore */
        }
    }, TICK_MS);

    const stop = () => {
        clearInterval(timer);
    };
    bot.once('end', stop);
    bot.once('kicked', stop);
}

export default attachFloorWatchdog;
