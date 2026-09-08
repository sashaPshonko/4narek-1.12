import { VIEW_HUB_HTTP } from './install.mjs';

const GUI_VIEW_URL = String(process.env.GUI_VIEW_URL || 'http://90.156.168.156:26080').replace(/\/$/, '');
const GUI_VIEW_TOKEN = String(process.env.GUI_VIEW_TOKEN || '').trim();
const FARM_VIEW_HOST = String(process.env.FARM_VIEW_HOST || '212.8.229.76').trim();

async function tellGuiConnect(farmPort) {
    if (!GUI_VIEW_URL || !GUI_VIEW_TOKEN || !farmPort) return null;
    const headers = { 'content-type': 'application/json' };
    if (GUI_VIEW_TOKEN) headers.authorization = `Bearer ${GUI_VIEW_TOKEN}`;
    const play = `${FARM_VIEW_HOST}:${farmPort}`;
    const res = await fetch(`${GUI_VIEW_URL}/connect`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: play, via: 'direct' }),
        signal: AbortSignal.timeout(120000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `gui ${res.status}`);
    return body;
}

function formatList(rows) {
    if (!rows.length) return 'никто не слушает view (воркеры ещё не поднялись или это овнер)';
    return rows.map((b) => {
        const mark = b.selected ? ' ← сейчас' : '';
        const an = b.anarchy != null ? `an${b.anarchy}` : '?';
        return `${b.username}  ${an}  :${b.port}${mark}`;
    }).join('\n');
}

export function attachBotViewTelegram(tgBot, chatId, { bots } = {}) {
    if (!tgBot || chatId == null) return;

    tgBot.onText(/^\/view(?:@\w+)?(?:\s+(.+))?$/i, async (msg, match) => {
        if ((Date.now() / 1000) - msg.date > 10) return;
        const arg = String(match[1] || '').trim();

        let hub = null;
        try {
            const res = await fetch(`${VIEW_HUB_HTTP}/bots`, { signal: AbortSignal.timeout(1200) });
            hub = await res.json();
        } catch {
            hub = null;
        }

        const local = [];
        if (bots && typeof bots.values === 'function') {
            for (const b of bots.values()) {
                if (!b?.viewPort || b.banned) continue;
                local.push({
                    username: b.username,
                    port: b.viewPort,
                    anarchy: b.anarchy,
                    selected: false,
                });
            }
        }

        const rows = hub?.bots?.length ? hub.bots : local;

        if (!arg) {
            const extra = hub
                ? '\n\nTLauncher: 127.0.0.1:25566 (туннель на 25566). /view ник — выбрать.'
                : '\n\nхаб не запущен — туннель на порт бота: ssh -L 25566:127.0.0.1:ПОРТ vps';
            await tgBot.sendMessage(chatId, `view:\n${formatList(rows)}${extra}`);
            return;
        }

        if (hub) {
            try {
                const res = await fetch(`${VIEW_HUB_HTTP}/select`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ username: arg }),
                    signal: AbortSignal.timeout(1500),
                });
                const body = await res.json();
                if (!res.ok) {
                    await tgBot.sendMessage(chatId, `нет такого: ${arg}\n${formatList(body.bots || rows)}`);
                    return;
                }
                let guiLine = '';
                try {
                    await tellGuiConnect(body.port);
                    guiLine = '\nTLauncher на GUI VPS заходит сам';
                } catch (err) {
                    guiLine = `\nGUI VPS: ${err.message}`;
                }
                await tgBot.sendMessage(
                    chatId,
                    `выбран ${body.username}\nTLauncher → 127.0.0.1:25566  (1.21.11, оффлайн)${guiLine}`,
                );
                return;
            } catch (err) {
                await tgBot.sendMessage(chatId, `хаб: ${err.message}`);
                return;
            }
        }

        const want = arg.toLowerCase();
        const row = rows.find((b) => String(b.username).toLowerCase() === want)
            || rows.find((b) => String(b.username).toLowerCase().startsWith(want));
        if (!row) {
            await tgBot.sendMessage(chatId, `нет ${arg}\n${formatList(rows)}`);
            return;
        }
        try {
            await tellGuiConnect(row.port);
            await tgBot.sendMessage(
                chatId,
                `${row.username} :${row.port}\nTLauncher на GUI VPS заходит сам (farm:${row.port})`,
            );
        } catch (err) {
            await tgBot.sendMessage(
                chatId,
                `${row.username} слушает 127.0.0.1:${row.port}\nGUI VPS: ${err.message}\nтуннель:\nssh -L 25566:127.0.0.1:${row.port} vps`,
            );
        }
    });
}
