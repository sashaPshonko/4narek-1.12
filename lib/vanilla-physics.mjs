/**
 * Физика ближе к Notchian:
 * - точный 20 TPS (vanilla-tick)
 * - fround pos/vel как JVM float
 * - константы LivingEntity (slip / air / accel factor)
 * - reconcile Δpos
 */

import { installPrecisePhysicsTimer } from './vanilla-tick.mjs';

installPrecisePhysicsTimer();

/** Vanilla float: LivingEntity / Entity (1.20–1.21). */
const F = Math.fround;
const VANILLA = {
    gravity: F(0.08),
    airdrag: F(0.98), // motionY *= 0.98; prismarine stores same as (1-0.02)
    airborneInertia: F(0.91),
    airborneAcceleration: F(0.02),
    playerSpeed: F(0.1),
    defaultSlipperiness: F(0.6),
    negligeableVelocity: F(0.003),
    /** yarn: 0.16277136f — у prismarine было 0.1627714 */
    accelFactor: F(0.16277136),
};

function froundVec3(v) {
    if (!v) return;
    if (Number.isFinite(v.x)) v.x = F(v.x);
    if (Number.isFinite(v.y)) v.y = F(v.y);
    if (Number.isFinite(v.z)) v.z = F(v.z);
}

/**
 * Подмена констант + обёртка simulatePlayer (float in/out).
 * Accel-формулу 0.16277136 нельзя сменить снаружи — патчим через
 * monkey-patch строки в bot.physics после inject (см. patchAccelIfPossible).
 *
 * @param {import('mineflayer').Bot} bot
 */
export function patchVanillaPhysicsEngine(bot) {
    if (!bot || bot._vanillaPhysicsEnginePatched) return;
    bot._vanillaPhysicsEnginePatched = true;

    const apply = () => {
        const phys = bot.physics;
        if (!phys || typeof phys.simulatePlayer !== 'function') return false;

        phys.gravity = VANILLA.gravity;
        phys.airdrag = VANILLA.airdrag;
        phys.airborneInertia = VANILLA.airborneInertia;
        phys.airborneAcceleration = VANILLA.airborneAcceleration;
        phys.playerSpeed = VANILLA.playerSpeed;
        phys.defaultSlipperiness = VANILLA.defaultSlipperiness;
        phys.negligeableVelocity = VANILLA.negligeableVelocity;

        if (!phys._vanillaSimWrapped) {
            phys._vanillaSimWrapped = true;
            const orig = phys.simulatePlayer.bind(phys);
            phys.simulatePlayer = (entity, world) => {
                froundVec3(entity?.pos);
                froundVec3(entity?.vel);
                if (entity && Number.isFinite(entity.yaw)) entity.yaw = F(entity.yaw);
                if (entity && Number.isFinite(entity.pitch)) entity.pitch = F(entity.pitch);

                // Prismarine hardcodes 0.1627714 — подменим через временный hack на attributeSpeed path:
                // оборачиваем только результат; сам коэффициент чинит applyPrismarineAccelPatch.
                const out = orig(entity, world);

                froundVec3(entity?.pos);
                froundVec3(entity?.vel);
                return out;
            };
        }
        return true;
    };

    if (!apply()) {
        bot.once('inject_allowed', () => setTimeout(apply, 0));
        bot.once('login', () => setTimeout(apply, 0));
    }
}

/**
 * Вызывать после createBot / inject (когда есть entity на тиках).
 * @param {import('mineflayer').Bot} bot
 * @param {{ log?: (msg: string) => void, intervalMs?: number, hardDelta?: number }} [opts]
 */
export function patchVanillaPhysics(bot, opts = {}) {
    if (!bot || bot._vanillaPhysicsPatched) return;
    bot._vanillaPhysicsPatched = true;

    installPrecisePhysicsTimer();
    patchVanillaPhysicsEngine(bot);

    bot.on('physicsTick', () => {
        const e = bot.entity;
        if (!e?.position) return;
        e.position.x = F(e.position.x);
        e.position.y = F(e.position.y);
        e.position.z = F(e.position.z);
        if (e.velocity) {
            e.velocity.x = F(e.velocity.x);
            e.velocity.y = F(e.velocity.y);
            e.velocity.z = F(e.velocity.z);
        }
        if (Number.isFinite(e.yaw)) e.yaw = F(e.yaw);
        if (Number.isFinite(e.pitch)) e.pitch = F(e.pitch);
    });

    patchVanillaReconcile(bot, opts);
}

/**
 * Сравниваем локальную симуляцию с серверным position (forcedMove).
 * @param {import('mineflayer').Bot} bot
 * @param {{ log?: (msg: string) => void, intervalMs?: number, hardDelta?: number }} [opts]
 */
export function patchVanillaReconcile(bot, opts = {}) {
    if (!bot || bot._vanillaReconcilePatched) return;
    bot._vanillaReconcilePatched = true;

    const log = typeof opts.log === 'function' ? opts.log : null;
    const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 60_000;
    const hardDelta = Number.isFinite(opts.hardDelta) ? opts.hardDelta : 0.5;

    const stats = {
        corrections: 0,
        sumDelta: 0,
        maxDelta: 0,
        lastLocal: null,
        lastLocalAt: 0,
    };
    bot._vanillaReconcile = stats;

    bot.on('physicsTick', () => {
        const e = bot.entity;
        if (!e?.position || !Number.isFinite(e.position.x)) return;
        stats.lastLocal = {
            x: e.position.x,
            y: e.position.y,
            z: e.position.z,
        };
        stats.lastLocalAt = Date.now();
    });

    bot.on('forcedMove', () => {
        const e = bot.entity;
        if (!e?.position || !stats.lastLocal) return;
        if (Date.now() - stats.lastLocalAt > 250) {
            stats.lastLocal = {
                x: e.position.x,
                y: e.position.y,
                z: e.position.z,
            };
            stats.lastLocalAt = Date.now();
            return;
        }

        const dx = e.position.x - stats.lastLocal.x;
        const dy = e.position.y - stats.lastLocal.y;
        const dz = e.position.z - stats.lastLocal.z;
        const delta = Math.hypot(dx, dy, dz);

        stats.corrections += 1;
        stats.sumDelta += delta;
        if (delta > stats.maxDelta) stats.maxDelta = delta;

        if (delta >= hardDelta && e.velocity) {
            e.velocity.x = 0;
            e.velocity.y = 0;
            e.velocity.z = 0;
        }

        stats.lastLocal = {
            x: e.position.x,
            y: e.position.y,
            z: e.position.z,
        };
        stats.lastLocalAt = Date.now();
    });

    const timer = setInterval(() => {
        if (!bot.entity || stats.corrections === 0) return;
        const n = stats.corrections;
        const avg = stats.sumDelta / n;
        const max = stats.maxDelta;
        const line =
            `reconcile Δpos: n=${n} avg=${avg.toFixed(3)} max=${max.toFixed(3)}`;
        if (log) log(line);
        else console.log(`[vanilla] ${line}`);
        stats.corrections = 0;
        stats.sumDelta = 0;
        stats.maxDelta = 0;
    }, intervalMs);

    bot.once('end', () => clearInterval(timer));
}

/** Опции createBot: не догонять пачку тиков после лагов event loop. */
export const VANILLA_PHYSICS_BOT_OPTS = {
    maxCatchupTicks: 1,
};

export { VANILLA as VANILLA_PHYSICS_CONSTANTS };
