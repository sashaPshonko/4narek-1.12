/**
 * Аварийный выход из падения: пока бот в АХ/продаже без WASD,
 * инерция от anti-AFK всё равно уносит в яму → смерть и дроп монет.
 *
 * Важно:
 * - незагруженный чанк ≠ падение (иначе spam /warp и Δpos~100);
 * - ghost-vy (скорость вниз при почти неизменной Y) — сброс vel, не warp.
 *   Иначе ванильная клиентская физика + watchdog убивают сессию.
 */

import {
    clearWasd,
    isStandingOnFloor,
    horizSpeed,
} from './wasd-pit-guard.mjs';
import { randomWarpCmd } from './warp-pick.mjs';

const FALL_VY = -0.35;
const FALL_MS = 450;
/** Реальное падение: Y должна уехать вниз хотя бы на столько. */
const MIN_Y_DROP = 1.25;
/** За FALL_MS Y почти не изменилась → ghost velocity, не яма. */
const GHOST_Y_DROP_MAX = 0.35;
const WARP_BUSY_MS = 8_000;
const MIN_WARP_GAP_MS = 20_000;
const TICK_MS = 80;

function chunkLoadedUnderFeet(bot) {
    const pos = bot?.entity?.position;
    if (!pos || !bot.blockAt) return false;
    try {
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

function zeroVel(ent) {
    if (!ent?.velocity) return;
    ent.velocity.x = 0;
    ent.velocity.y = 0;
    ent.velocity.z = 0;
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{
 *   log?: (msg: string) => void,
 *   warpCmd?: string | (() => string),
 *   shouldIgnore?: () => boolean,
 *   onVoidFall?: () => void,
 * }} [opts]
 */
export function attachFloorWatchdog(bot, opts = {}) {
    if (!bot || bot.__floorWatchdogAttached) return;
    bot.__floorWatchdogAttached = true;

    const logFn = typeof opts.log === 'function' ? opts.log : () => {};
    const resolveWarpCmd = () => {
        if (typeof opts.warpCmd === 'function') return opts.warpCmd();
        if (typeof opts.warpCmd === 'string' && opts.warpCmd) return opts.warpCmd;
        return randomWarpCmd();
    };
    let offFloorSince = 0;
    let fallStartY = null;
    let warping = false;
    let lastWarpAt = 0;

    const resetFall = () => {
        offFloorSince = 0;
        fallStartY = null;
    };

    const timer = setInterval(() => {
        try {
            if (typeof opts.shouldIgnore === 'function' && opts.shouldIgnore()) {
                resetFall();
                return;
            }
            const ent = bot.entity;
            if (!ent?.position) {
                resetFall();
                return;
            }
            if (typeof bot.health === 'number' && bot.health <= 0) {
                resetFall();
                return;
            }
            if (bot._client?.state && bot._client.state !== 'play') {
                resetFall();
                return;
            }
            if (!chunkLoadedUnderFeet(bot)) {
                resetFall();
                return;
            }

            const onFloor = isStandingOnFloor(bot);
            const vy = ent.velocity?.y ?? 0;
            const seemingFall = !onFloor && vy <= FALL_VY;

            if (!seemingFall) {
                resetFall();
                return;
            }

            if (!offFloorSince) {
                offFloorSince = Date.now();
                fallStartY = ent.position.y;
            }
            if (Date.now() - offFloorSince < FALL_MS) return;

            const yDrop = (fallStartY ?? ent.position.y) - ent.position.y;

            // Клиентская физика иногда крутит vy вниз, пока Y почти стоит
            // (desync / float). Warp тут только усугубляет Δpos.
            if (yDrop < GHOST_Y_DROP_MAX) {
                zeroVel(ent);
                try {
                    ent.onGround = true;
                } catch {
                    /* ignore */
                }
                logFn(
                    `floor-watchdog → ghost-fall suppressed vy=${vy.toFixed(2)} Δy=${yDrop.toFixed(2)}`,
                );
                resetFall();
                return;
            }

            if (yDrop < MIN_Y_DROP) return;

            // Void / лимобо: огромный Δy или низкий Y — /warp бесполезен («нет команд»).
            const yNow = ent.position.y;
            if (yDrop >= 8 || yNow < 30) {
                zeroVel(ent);
                logFn(
                    `floor-watchdog → void/limbo vy=${vy.toFixed(2)} Δy=${yDrop.toFixed(1)} y=${yNow.toFixed(1)} — rejoin`,
                );
                resetFall();
                lastWarpAt = Date.now();
                try {
                    opts.onVoidFall?.();
                } catch {
                    /* ignore */
                }
                return;
            }

            if (warping) return;
            if (Date.now() - lastWarpAt < MIN_WARP_GAP_MS) return;

            warping = true;
            lastWarpAt = Date.now();
            clearWasd(bot);
            try {
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
            } catch {
                /* ignore */
            }
            zeroVel(ent);
            // physics НЕ гасим надолго: ванильный тик + выкл → ещё больший desync.
            const spd = horizSpeed(bot);
            const warpCmd = resolveWarpCmd();
            logFn(
                `floor-watchdog → падение vy=${vy.toFixed(2)} Δy=${yDrop.toFixed(1)} spd=${Number.isFinite(spd) ? spd.toFixed(2) : '?'} → ${warpCmd}`,
            );
            try {
                bot.chat(warpCmd);
            } catch (err) {
                logFn(`floor-watchdog → chat fail: ${err?.message || err}`);
            }
            setTimeout(() => {
                warping = false;
                resetFall();
                zeroVel(bot.entity);
            }, WARP_BUSY_MS);
        } catch {
            /* ignore */
        }
    }, TICK_MS);

    // Серверный телепорт (warp/respawn) — сбросить «падение» и vel.
    bot.on('forcedMove', () => {
        resetFall();
        zeroVel(bot.entity);
        try {
            if (bot.entity) bot.entity.onGround = true;
        } catch {
            /* ignore */
        }
    });

    const stop = () => {
        clearInterval(timer);
    };
    bot.once('end', stop);
    bot.once('kicked', stop);
}

export default attachFloorWatchdog;
