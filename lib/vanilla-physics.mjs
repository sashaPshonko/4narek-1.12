/**
 * Физика ближе к Notchian:
 * - точный 20 TPS (vanilla-tick)
 * - fround vel (как JVM float) — но НЕ position каждый тик
 *   (fround pos ломал коллизии → «падение сквозь пол» → floor-watchdog loop)
 * - константы LivingEntity (slip / air / accel factor)
 * - reconcile Δpos (+ игнор варп-скачков в метрике)
 */

import { installPrecisePhysicsTimer } from './vanilla-tick.mjs';
import { isStandingOnFloor } from './wasd-pit-guard.mjs';

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
 * Подмена констант + обёртка simulatePlayer.
 * fround только vel/yaw — position трогаем после сима минимально (итог тика),
 * чтобы не сдвинуть AABB до коллизии.
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
                // До сима — только vel/углы. Position fround ДО коллизии
                // уводил ноги «между» вокселями → fall-through на FunTime.
                froundVec3(entity?.vel);
                if (entity && Number.isFinite(entity.yaw)) entity.yaw = F(entity.yaw);
                if (entity && Number.isFinite(entity.pitch)) entity.pitch = F(entity.pitch);

                const out = orig(entity, world);

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
 * Если блок под ногами есть, а vy всё ещё «падаем» — ghost после float/desync.
 * Глушим, не трогая маскировку пакетов.
 */
function dampenGhostFall(bot) {
    const e = bot?.entity;
    if (!e?.velocity || !e.position) return;
    if (!(e.velocity.y < -0.08)) return;
    if (!isStandingOnFloor(bot)) return;
    e.velocity.y = 0;
    if (Math.abs(e.velocity.x) < 0.003) e.velocity.x = 0;
    if (Math.abs(e.velocity.z) < 0.003) e.velocity.z = 0;
    try {
        e.onGround = true;
    } catch {
        /* ignore */
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
        // Vel/yaw как float JVM — position не трогаем каждый тик.
        if (e.velocity) froundVec3(e.velocity);
        if (Number.isFinite(e.yaw)) e.yaw = F(e.yaw);
        if (Number.isFinite(e.pitch)) e.pitch = F(e.pitch);
        dampenGhostFall(bot);
    });

    patchVanillaReconcile(bot, opts);
}

/**
 * Сравниваем локальную симуляцию с серверным position (forcedMove).
 * @param {import('mineflayer').Bot} bot
 * @param {{ log?: (msg: string) => void, intervalMs?: number, hardDelta?: number, maxMetricDelta?: number }} [opts]
 */
export function patchVanillaReconcile(bot, opts = {}) {
    if (!bot || bot._vanillaReconcilePatched) return;
    bot._vanillaReconcilePatched = true;

    const log = typeof opts.log === 'function' ? opts.log : null;
    const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : 60_000;
    const hardDelta = Number.isFinite(opts.hardDelta) ? opts.hardDelta : 0.5;
    /** Варп/телепорт — не метрика физики; режем из avg. */
    const maxMetricDelta = Number.isFinite(opts.maxMetricDelta) ? opts.maxMetricDelta : 4;

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
        if (!e?.position) return;

        if (!stats.lastLocal || Date.now() - stats.lastLocalAt > 250) {
            stats.lastLocal = {
                x: e.position.x,
                y: e.position.y,
                z: e.position.z,
            };
            stats.lastLocalAt = Date.now();
            if (e.velocity) {
                e.velocity.x = 0;
                e.velocity.y = 0;
                e.velocity.z = 0;
            }
            try {
                e.onGround = true;
            } catch {
                /* ignore */
            }
            return;
        }

        const dx = e.position.x - stats.lastLocal.x;
        const dy = e.position.y - stats.lastLocal.y;
        const dz = e.position.z - stats.lastLocal.z;
        const delta = Math.hypot(dx, dy, dz);

        if (delta <= maxMetricDelta) {
            stats.corrections += 1;
            stats.sumDelta += delta;
            if (delta > stats.maxDelta) stats.maxDelta = delta;
        }

        if (delta >= hardDelta && e.velocity) {
            e.velocity.x = 0;
            e.velocity.y = 0;
            e.velocity.z = 0;
            try {
                e.onGround = true;
            } catch {
                /* ignore */
            }
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
