/**
 * Короткий заход владельца клана: жив / забанен.
 * Не создаёт клан — только login → spawn или kick.
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

function isBanKickReason(reason) {
    const s = String(reason || '').toLowerCase();
    if (!s) return false;
    if (s.includes('ником уже онлайн') || s.includes('таким-же ником') || s.includes('already online')) {
        return false;
    }
    return (
        s.includes('забанен')
        || s.includes('заблокирован')
        || s.includes('banned')
        || s.includes('blacklist')
        || s.includes('blacklisted')
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

function buildProxy(proxyString) {
    const url = new URL(proxyString);
    const host = url.hostname;
    const port = Number(url.port);
    const username = url.username || undefined;
    const password = url.password || undefined;
    const agent = new SocksProxyAgent(proxyString);
    const connect = (client) => {
        SocksClient.createConnection({
            proxy: {
                host,
                port,
                type: 5,
                userId: username,
                password,
            },
            command: 'connect',
            destination: { host: client.host, port: client.port },
            timeout: 20_000,
        }).then(({ socket }) => {
            client.setSocket(socket);
            client.emit('connect');
        }).catch((err) => client.emit('error', err));
    };
    return { agent, connect };
}

/**
 * @returns {Promise<{ status: 'ok'|'banned'|'error', reason?: string }>}
 */
export async function pingClanOwner({ username, password, proxyString, log = console.log }) {
    if (!username || !password || !proxyString) {
        return { status: 'error', reason: 'нет username/password/proxy' };
    }

    const proxy = buildProxy(proxyString);
    let settled = false;
    let bot = null;

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
                agent: proxy.agent,
                connect: proxy.connect,
                hideErrors: true,
                checkTimeoutInterval: 60_000,
            });
        } catch (e) {
            clearTimeout(timer);
            done({ status: 'error', reason: e.message });
            return;
        }

        attachMapCache(bot);

        bot.on('kicked', (reason) => {
            const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
            log(`[clan-owner-ping] ${username} kicked: ${text.slice(0, 200)}`);
            clearTimeout(timer);
            if (isBanKickReason(text)) {
                done({ status: 'banned', reason: text.slice(0, 500) });
            } else {
                done({ status: 'error', reason: `kicked: ${text.slice(0, 200)}` });
            }
        });

        bot.on('end', () => {
            if (settled) return;
            clearTimeout(timer);
            done({ status: 'error', reason: 'connection end' });
        });

        bot.on('error', (err) => {
            if (settled) return;
            log(`[clan-owner-ping] ${username} error: ${err.message}`);
        });

        bot.on('messagestr', (msg) => {
            const text = String(msg || '');
            if (!text) return;
            if (isCaptchaChat(text)) {
                void handleCaptchaLogin(bot, {
                    password,
                    solverUrl: SOLVER_URL,
                    username,
                    infinite: false,
                    log: (...a) => log(`[clan-owner-ping] ${a.join(' ')}`),
                }).catch((e) => log(`[clan-owner-ping] captcha: ${e.message}`));
                return;
            }
            if (text.toLowerCase().includes('чтобы двигаться')) {
                log(`[clan-owner-ping] ${username} хуйня → funauth`);
                requestFunauthBindHttp(username, password);
                clearTimeout(timer);
                done({ status: 'error', reason: 'funauth' });
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
            log(`[clan-owner-ping] ${username} spawn ok`);
            try {
                bot.chat(`/l ${password}`);
            } catch { /* ignore */ }
            await sleep(1500);
            clearTimeout(timer);
            done({ status: 'ok' });
        });
    });
}
