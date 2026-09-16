/**
 * Отпечаток «обычного» клиента: brand + settings как у vanilla launcher.
 * Вызывать после createBot (inject) и после configuration → play.
 *
 * Chat signing (1.19+): на FunTime offline `/l` — ключей Mojang нет.
 * Ванильный cracked-клиент тоже шлёт chat_command без signature; «полный»
 * signing возможен только с auth: 'microsoft' + premium-аккаунт.
 */

import './vanilla-tick.mjs'; // 20 TPS hook до createBot/login
import { VANILLA_PHYSICS_BOT_OPTS } from './vanilla-physics.mjs';

/** Опции createBot поверх наших (прокси и т.п.). */
export const VANILLA_BOT_OPTS = {
    brand: 'vanilla',
    physicsEnabled: true,
    viewDistance: 8,
    mainHand: 'right',
    chat: 'enabled',
    colorsEnabled: true,
    ...VANILLA_PHYSICS_BOT_OPTS,
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
            // как у дефолтного launcher skin layers
            skinParts: {
                showCape: true,
                showJacket: true,
                showLeftSleeve: true,
                showRightSleeve: true,
                showLeftPants: true,
                showRightPants: true,
                showHat: true,
            },
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
