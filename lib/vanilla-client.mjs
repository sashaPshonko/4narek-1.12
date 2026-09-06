/**
 * Отпечаток «обычного» клиента: brand + settings как у vanilla launcher.
 * Вызывать после createBot (inject) и после configuration → play.
 */

/** Опции createBot поверх наших (прокси и т.п.). */
export const VANILLA_BOT_OPTS = {
    brand: 'vanilla',
    // createBot: physics off until configuration→play (FunTime transfer); includePhysicsOn после входа
    physicsEnabled: false,
    viewDistance: 8,
    mainHand: 'right',
    chat: 'enabled',
    colorsEnabled: true,
};

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ locale?: string, viewDistance?: number | string }} [opts]
 */
export function applyVanillaClientSettings(bot, opts = {}) {
    if (!bot || typeof bot.setSettings !== 'function') return;
    const locale = opts.locale || 'ru_RU';
    const viewDistance = opts.viewDistance ?? 8;
    try {
        bot.setSettings({
            locale,
            viewDistance,
            chat: 'enabled',
            colorsEnabled: true,
            mainHand: 'right',
            enableTextFiltering: false,
            enableServerListing: true,
        });
    } catch (err) {
        console.error('[vanilla-client] setSettings:', err?.message || err);
    }
}

/** Physics как у живого клиента; false только на время configuration. */
export function ensurePhysicsOn(bot) {
    if (!bot) return;
    if (bot.physicsEnabled !== true) bot.physicsEnabled = true;
}
