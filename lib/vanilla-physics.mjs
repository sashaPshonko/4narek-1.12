/**
 * Физика ближе к Notchian (JVM float), без подмены всего движка.
 * Полный JVM в Node нельзя — это fround координат/скорости + меньше catchup.
 */

/**
 * Вызывать после createBot / inject (когда есть entity на тиках).
 * @param {import('mineflayer').Bot} bot
 */
export function patchVanillaPhysics(bot) {
    if (!bot || bot._vanillaPhysicsPatched) return;
    bot._vanillaPhysicsPatched = true;

    bot.on('physicsTick', () => {
        const e = bot.entity;
        if (!e?.position) return;
        // LivingEntity / Vec3 в клиенте — float
        e.position.x = Math.fround(e.position.x);
        e.position.y = Math.fround(e.position.y);
        e.position.z = Math.fround(e.position.z);
        if (e.velocity) {
            e.velocity.x = Math.fround(e.velocity.x);
            e.velocity.y = Math.fround(e.velocity.y);
            e.velocity.z = Math.fround(e.velocity.z);
        }
        if (Number.isFinite(e.yaw)) e.yaw = Math.fround(e.yaw);
        if (Number.isFinite(e.pitch)) e.pitch = Math.fround(e.pitch);
    });
}

/** Опции createBot: не догонять пачку тиков после лагов event loop (рывки ≠ ваниль). */
export const VANILLA_PHYSICS_BOT_OPTS = {
    maxCatchupTicks: 1,
};
