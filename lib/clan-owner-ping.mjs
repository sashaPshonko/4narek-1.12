/**
 * Короткий заход владельца клана: жив / забанен.
 * Прокси + configuration-transfer — как в clan-setup (иначе FunTime рвёт до spawn).
 */
import mineflayer from 'mineflayer';
import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { handleCaptchaLogin, attachMapCache, isCaptchaChat } from './captcha/solve-flow.mjs';

const SOLVER_URL = process.env.CAPTCHA_SOLVER_URL || 'http://127.0.0.1:8799';
const GO_HTTP = process.env.GO_HTTP_URL
    || (process.env.LOCAL_MODE === '1' || process.env.LOCAL_MODE === 'true'
        ? 'http://127.0.0.1:8080'
        : 'http://212.8.229.76:8080');

const CONFIG_BLOCKED = new Set([
    'position', 'look', 'position_look', 'flying',
    'chat', 'chat_command', 'chat_command_signed', 'chat_message',
    'window_click', 'close_window',
    'arm_animation', 'entity_action',
    'held_item_slot', 'set_creative_slot',
]);

function isBanKickReason(reason) {
    const s = String(reason || '').toLowerCase();
    if (!s) return false;
    if (s.includes('ником уже онлайн') || s.includes('таким-же ником') || s.includes('already online')) {
        return false;
    }
    return (
        s.includes('забанен')
        || s.includes('забанили')
        || s.includes('заблокирован')
        || s.includes('блокировк')
        || s.includes('banned')
        || s.includes('blacklist')
        || s.includes('blacklisted')
        || s.includes('funac')
        || s.includes('autobuy')
        || s.includes('пункт 4')
        || s.includes('4.3.1')
        || /\bban\b/.test(s)
    );
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function requestFunauthBindHttp(nick, password) {
    if (!nick || !password) return;
    fetch(`${GO_HTTP}/api/funauth/bind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nick, password }),
    }).catch(() => {});
}

function flattenKickReason(reason) {
    if (reason == null) return '';
    if (typeof reason === 'string') return reason;
    try {
        return JSON.stringify(reason);
    } catch {
        return String(reason);
    }
}

function ensureRegistryDimensionStub(bot) {
    if (Array.isArray(bot.registry.dimensionsArray) && bot.registry.dimensionsArray.length > 0) {
        return;
    }
    const fallback = { name: 'minecraft:overworld', minY: -64, height: 384 };
    bot.registry.dimensionsArray = Array.from({ length: 16 }, () => fallback);
    bot.registry.dimensionsByName ??= { overworld: fallback };
}

function setupConfigurationTransferFix(bot, log) {
    const client = bot._client;
    if (!client) return;

    const origLoad = bot.registry.loadDimensionCodec.bind(bot.registry);
    bot.registry.loadDimensionCodec = (codec) => {
        try {
            origLoad(codec);
        } catch {
            ensureRegistryDimensionStub(bot);
        }
    };

    client.prependListener('login', () => ensureRegistryDimensionStub(bot));
    client.prependListener('respawn', () => ensureRegistryDimensionStub(bot));

    const PACK_ACCEPTED = 3;
    const PACK_LOADED = 0;
    let blockSelectKnownPacksWrite = false;
    const origWrite = client.write.bind(client);
    client.write = (name, params) => {
        if (client.state === 'configuration' && CONFIG_BLOCKED.has(name)) return;
        if (blockSelectKnownPacksWrite && name === 'select_known_packs') return;
        return origWrite(name, params);
    };

    client.on('start_configuration', () => {
        blockSelectKnownPacksWrite = false;
        bot.physicsEnabled = false;
        log('transfer → configuration');
    });
    client.on('finish_configuration', () => {
        blockSelectKnownPacksWrite = false;
        bot.physicsEnabled = true;
        log('transfer → configuration ok');
    });
    client.on('cookie_request', (data) => {
        if (client.state !== 'configuration') return;
        origWrite('cookie_response', { key: data.cookie });
    });
    client.prependListener('add_resource_pack', (data) => {
        if (client.state !== 'configuration') return;
        origWrite('resource_pack_receive', { uuid: data.uuid, result: PACK_ACCEPTED });
        origWrite('resource_pack_receive', { uuid: data.uuid, result: PACK_LOADED });
    });
    client.prependListener('select_known_packs', (data) => {
        if (client.state !== 'configuration') return;
        const packs = (data.packs ?? []).map((p) => ({
            namespace: p.namespace,
            id: p.id,
            version: p.version,
        }));
        blockSelectKnownPacksWrite = true;
        try {
            origWrite('select_known_packs', { packs });
        } finally {
            blockSelectKnownPacksWrite = false;
        }
    });
}

/** Как в clan-setup: agent object + destination на FunTime. */
function buildProxyConnect(proxyString) {
    const url = new URL(proxyString);
    const proxyHost = url.hostname;
    const proxyPort = Number(url.port);
    const proxyUsername = url.username ? decodeURIComponent(url.username) : undefined;
    const proxyPassword = url.password ? decodeURIComponent(url.password) : undefined;
    const agent = new SocksProxyAgent({
        protocol: 'socks5:',
        host: proxyHost,
        port: proxyPort,
        username: proxyUsername,
        password: proxyPassword,
    });
    const connect = (client) => {
        SocksClient.createConnection(
            {
                proxy: {
                    host: proxyHost,
                    port: proxyPort,
                    type: 5,
                    userId: proxyUsername,
                    password: proxyPassword,
                },
                command: 'connect',
                destination: { host: 'mc.funtime.su', port: 25565 },
                timeout: 20_000,
            },
            (err, info) => {
                if (err) {
                    client.emit('error', err);
                    return;
                }
                client.setSocket(info.socket);
                client.emit('connect');
            },
        );
    };
    return { agent, connect, label: `${proxyHost}:${proxyPort}` };
}

/**
 * @returns {Promise<{ status: 'ok'|'banned'|'error', reason?: string }>}
 */
export async function pingClanOwner({ username, password, proxyString, log = console.log }) {
    if (!username || !password || !proxyString) {
        return { status: 'error', reason: 'нет username/password/proxy' };
    }

    const proxy = buildProxyConnect(proxyString);
    let settled = false;
    let bot = null;
    let lastKick = '';

    const finish = (result) => {
        if (settled) return result;
        settled = true;
        try {
            bot?.removeAllListeners?.();
            bot?.quit?.();
        } catch { /* ignore */ }
        return result;
    };

    return new Promise((resolve) => {
        const done = (result) => resolve(finish(result));
        const timer = setTimeout(() => {
            log(`[clan-owner-ping] ${username} timeout`);
            done({ status: 'error', reason: 'timeout' });
        }, 90_000);

        try {
            bot = mineflayer.createBot({
                username,
                password,
                host: 'mc.funtime.su',
                port: 25565,
                version: '1.21.11',
                physicsEnabled: false,
                hideErrors: true,
                logErrors: false,
                agent: proxy.agent,
                connect: proxy.connect,
                checkTimeoutInterval: 60_000,
            });
        } catch (e) {
            clearTimeout(timer);
            done({ status: 'error', reason: e.message });
            return;
        }

        const plog = (...a) => log(`[clan-owner-ping] ${username} ${a.join(' ')}`);
        attachMapCache(bot);
        setupConfigurationTransferFix(bot, plog);

        bot.on('login', () => {
            plog('login');
        });

        bot.on('kicked', (reason) => {
            const text = flattenKickReason(reason);
            lastKick = text;
            plog(`kicked: ${text.slice(0, 240)}`);
            clearTimeout(timer);
            if (isBanKickReason(text)) {
                done({ status: 'banned', reason: text.slice(0, 500) });
            } else {
                done({ status: 'error', reason: `kicked: ${text.slice(0, 240)}` });
            }
        });

        bot.on('end', () => {
            if (settled) return;
            // FunTime часто шлёт end раньше kicked — даём kicked шанс
            setTimeout(() => {
                if (settled) return;
                clearTimeout(timer);
                if (lastKick && isBanKickReason(lastKick)) {
                    done({ status: 'banned', reason: lastKick.slice(0, 500) });
                    return;
                }
                done({
                    status: 'error',
                    reason: lastKick
                        ? `end after kick: ${lastKick.slice(0, 200)}`
                        : 'connection end',
                });
            }, 800);
        });

        bot.on('error', (err) => {
            if (settled) return;
            plog(`error: ${err.message}`);
        });

        bot.on('messagestr', (msg) => {
            const text = String(msg || '');
            if (!text) return;
            if (isCaptchaChat(text)) {
                void handleCaptchaLogin(bot, {
                    password,
                    solverUrl: SOLVER_URL,
                    username,
                    infinite: true,
                    log: (...a) => plog(a.join(' ')),
                }).catch((e) => plog(`captcha: ${e.message}`));
                return;
            }
            if (text.toLowerCase().includes('чтобы двигаться')) {
                plog('хуйня → funauth, ждём bind (не рвём сразу)');
                requestFunauthBindHttp(username, password);
                // не done(error): после bind сессия может ожить; если нет — timeout/end
                return;
            }
            if (
                text.includes('Зарегистрируйтесь')
                || text.includes('/reg <')
                || text.includes('/reg<')
            ) {
                bot.chat(`/reg ${password}`);
                setTimeout(() => bot.chat(`/l ${password}`), 600);
                return;
            }
            if (text.includes('Сначала авторизируйтесь') || text.includes('Авторизируйтесь')) {
                bot.chat(`/l ${password}`);
            }
        });

        bot.once('spawn', async () => {
            plog('spawn ok');
            try {
                bot.chat(`/l ${password}`);
            } catch { /* ignore */ }
            await sleep(1200);
            clearTimeout(timer);
            done({ status: 'ok' });
        });
    });
}
