import { parentPort } from 'worker_threads';
import { createPacketCache } from './cache.mjs';
import { startAttachServer } from './attach.mjs';
import { tapClientPackets, shouldForwardLiveWire } from './wire.mjs';

export const VIEW_HUB_HTTP = 'http://127.0.0.1:25999';

/** `504-2` → 25042. Только localhost. */
export function viewPortFromIp(ip) {
    const m = String(ip || '').match(/^(\d+)-(\d+)$/);
    if (!m) return null;
    return 20000 + Number(m[1]) * 10 + Number(m[2]);
}

export function isClanOwnerUsername(username, ownersDoc) {
    const want = String(username || '').trim().toLowerCase();
    if (!want || !ownersDoc || typeof ownersDoc !== 'object') return false;
    for (const [key, row] of Object.entries(ownersDoc)) {
        if (key === 'myNick') continue;
        const nick = String(row?.username || '').trim().toLowerCase();
        if (nick && nick === want) return true;
    }
    return false;
}

async function registerHub(payload) {
    try {
        await fetch(`${VIEW_HUB_HTTP}/register`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(1500),
        });
    } catch {
        /* хаб не запущен — прямой порт всё равно слушает */
    }
}

/**
 * Зритель TLauncher на 127.0.0.1. Сессия FunTime не трогается.
 * Движение из лаунчера на сервер не идёт, чат — да.
 */
export function installBotView(bot, {
    username,
    ip,
    anarchy,
    log = console.log,
    onSpectatorChat,
} = {}) {
    const port = viewPortFromIp(ip);
    if (!port) {
        log(`view: нет порта для ip=${ip}`);
        return null;
    }
    if (!bot?._client) {
        log('view: нет _client');
        return null;
    }

    const cache = createPacketCache();
    let attach = null;
    let lastChatAt = 0;

    tapClientPackets(bot._client, (state, buf) => {
        cache.onWire(state, buf);
        if (attach && shouldForwardLiveWire(state, buf)) {
            attach.forwardFromBot(buf);
        }
    });
    bot._client.prependListener('packet', (data, meta, buffer, fullBuffer) => {
        cache.onPacket(data, meta, buffer, fullBuffer);
    });

    attach = startAttachServer({
        host: '127.0.0.1',
        port,
        version: '1.21.11',
        motd: `view · ${username}`,
        cache,
        getBot: () => bot,
        onSpectatorChat: (text) => {
            const now = Date.now();
            if (now - lastChatAt < 250) return;
            lastChatAt = now;
            if (typeof onSpectatorChat === 'function') onSpectatorChat(text);
            else {
                try { bot.chat(text); } catch { /* ignore */ }
            }
        },
        log,
    });

    bot._client.on('start_configuration', () => {
        attach.beginWorldChange().catch((err) => log(`view beginWorld: ${err?.message || err}`));
    });
    bot._client.on('login', () => {
        attach.finishWorldChange().catch((err) => log(`view finishWorld: ${err?.message || err}`));
    });
    bot.on('end', () => attach.kickAll('бот отключился'));
    bot.on('kicked', () => attach.kickAll('бот кикнут'));

    const payload = { username, port, anarchy: Number(anarchy) || null };
    registerHub(payload);
    const hubTimer = setInterval(() => registerHub(payload), 15000);
    hubTimer.unref?.();
    bot.on('end', () => clearInterval(hubTimer));

    try {
        parentPort?.postMessage({ name: 'view_listen', username, port, anarchy });
    } catch { /* parent gone */ }

    return attach;
}
