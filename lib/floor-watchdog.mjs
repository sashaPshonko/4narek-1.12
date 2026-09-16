/**
 * Аварийный выход из падения: пока бот в АХ/продаже без WASD,
 * инерция от anti-AFK всё равно уносит в яму → смерть и дроп монет.
 * Ловим полёт вниз и варпаем на shop.
 *
 * Важно: незагруженный чанк ≠ падение. Иначе spam /warp shop и Δpos~100.
 */

import {
    clearWasd,
    isStandingOnFloor,
    horizSpeed,
} from './wasd-pit-guard.mjs';

const FALL_VY = -0.35;
const FALL_MS = 450;
/** После своего warp — не долбить чат, пока не приземлимся / таймаут. */
const WARP_BUSY_MS = 12_000;
/** Абсолютный антиспам между варпами. */
const MIN_WARP_GAP_MS = 15_000;
const TICK_MS = 80;

function chunkLoadedUnderFeet(bot) {
    const pos = bot?.entity?.position;
    if (!pos || !bot.blockAt) return false;
    try {
        // null = чанк не подгружен; air/block = мир есть
        const here = bot.blockAt(pos, false);
        if (here != null) return true;
        const below = bot.blockAt(
            { x: pos.x, y: pos.y - 1, z: pos.z },
            false,
        );
        return below != null;
    } catch {
        return false;
    }
}

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
    let warping = false;
    let lastWarpAt = 0;

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
            if (typeof bot.health === 'number' && bot.health <= 0) {
                offFloorSince = 0;
                return;
            }
            // configuration / transfer — физика и чанки ещё не play
            if (bot._client?.state && bot._client.state !== 'play') {
                offFloorSince = 0;
                return;
            }
            // без блоков под ногами нельзя решать «падение» — иначе вечный /warp
            if (!chunkLoadedUnderFeet(bot)) {
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
            if (Date.now() - lastWarpAt < MIN_WARP_GAP_MS) return;

            warping = true;
            lastWarpAt = Date.now();
            clearWasd(bot);
            // пока летим/варпаем — не слать клиентскую физику в пустоту
            try {
                bot.physicsEnabled = false;
            } catch {
                /* ignore */
            }
            try {
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
            } catch {
                /* ignore */
            }
            if (ent.velocity) {
                ent.velocity.x = 0;
                ent.velocity.y = 0;
                ent.velocity.z = 0;
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
                try {
                    if (bot._client?.state === 'play') bot.physicsEnabled = true;
                } catch {
                    /* ignore */
                }
            }, WARP_BUSY_MS);
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
