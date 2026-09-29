/**
 * FunTime keep_alive = i64. После configuration mineflayer/nmp иногда не эмитит
 * packet → штатный keepalive.js не отвечает → keepAliveError через 30с.
 *
 * Ставим keepAlive: false в createBot и отвечаем сырым echo i64 с wire.
 */

import { replyKeepAlive, tapClientPackets } from './bot-view/wire.mjs';

/** Опция createBot: выключить встроенный keepalive.js */
export const FUNTIME_KEEPALIVE_BOT_OPTS = {
    keepAlive: false,
};

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ checkTimeoutInterval?: number }} [opts]
 */
export function installFuntimeKeepAlive(bot, opts = {}) {
    const client = bot?._client;
    if (!client || client._funtimeKeepAliveInstalled) return;
    client._funtimeKeepAliveInstalled = true;

    const checkTimeoutInterval = Number(opts.checkTimeoutInterval) > 0
        ? Number(opts.checkTimeoutInterval)
        : 60_000;

    let timeout = null;
    const clear = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
    };
    const arm = () => {
        clear();
        timeout = setTimeout(() => {
            try {
                client.emit('error', new Error(
                    `client timed out after ${checkTimeoutInterval} milliseconds`,
                ));
            } catch { /* ignore */ }
            try {
                client.end('keepAliveError');
            } catch { /* ignore */ }
        }, checkTimeoutInterval);
        timeout.unref?.();
    };

    client.on('end', clear);
    bot.once?.('end', clear);

    tapClientPackets(client, (state, buf) => {
        if (replyKeepAlive(client, state, buf)) arm();
    });
}
