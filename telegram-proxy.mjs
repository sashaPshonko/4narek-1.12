import { SocksProxyAgent } from 'socks-proxy-agent';

/** TELEGRAM_PROXY=socks5h://127.0.0.1:1080 | http://127.0.0.1:1080 | off */
export function resolveTelegramProxyUrl() {
    const value = process.env.TELEGRAM_PROXY;
    if (value === 'off' || value === '0' || value === 'false') {
        return null;
    }
    return value || 'socks5h://127.0.0.1:1080';
}

export function buildTelegramBotOptions() {
    const proxyUrl = resolveTelegramProxyUrl();
    if (!proxyUrl) {
        console.log('[Telegram] без прокси (TELEGRAM_PROXY=off)');
        return { polling: true };
    }

    const lower = proxyUrl.toLowerCase();
    const request = {};

    if (lower.startsWith('http://') || lower.startsWith('https://')) {
        request.proxy = proxyUrl;
    } else {
        request.agent = new SocksProxyAgent(proxyUrl);
    }

    console.log(`[Telegram] прокси: ${proxyUrl}`);
    return { polling: true, request };
}

export function attachTelegramDiagnostics(bot) {
    bot.on('polling_error', (error) => {
        console.error('[Telegram polling_error]', error.code || '', error.message);
    });
}
