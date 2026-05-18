import net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';
import { access, unlink } from 'fs/promises';
import { constants } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SocksProxyAgent } from 'socks-proxy-agent';

const execAsync = promisify(exec);
const __proxyDir = dirname(fileURLToPath(import.meta.url));
const XRAY_SCRIPT = join(__proxyDir, 'xray.sh');
const XRAY_LOCK = '/tmp/4narek-xray-start.lock';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** TELEGRAM_PROXY=socks5h://127.0.0.1:1080 | http://127.0.0.1:1080 | off */
export function resolveTelegramProxyUrl() {
    const value = process.env.TELEGRAM_PROXY;
    if (value === 'off' || value === '0' || value === 'false') {
        return null;
    }
    return value || 'socks5h://127.0.0.1:1080';
}

function parseProxyHostPort(proxyUrl) {
    const normalized = proxyUrl
        .replace(/^socks5h?:\/\//i, 'http://')
        .replace(/^socks5:\/\//i, 'http://');
    const url = new URL(normalized);
    return {
        host: url.hostname,
        port: Number(url.port || 1080),
    };
}

export function isTelegramProxyReachable(proxyUrl, timeoutMs = 2000) {
    const { host, port } = parseProxyHostPort(proxyUrl);
    return new Promise((resolve) => {
        const socket = net.connect({ host, port });
        const done = (ok) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(ok);
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

async function runXrayScript() {
    await access(XRAY_SCRIPT, constants.R_OK);
    const cmd = process.env.TELEGRAM_XRAY_CMD || `bash ${JSON.stringify(XRAY_SCRIPT)}`;
    console.log(`[Telegram] запускаю xray: ${cmd}`);
    const { stdout, stderr } = await execAsync(cmd, {
        cwd: __proxyDir,
        timeout: 180_000,
        maxBuffer: 10 * 1024 * 1024,
        env: process.env,
    });
    if (stdout?.trim()) console.log(stdout.trim());
    if (stderr?.trim()) console.error(stderr.trim());
}

/** Поднять SOCKS через xray.sh, если 1080 недоступен (один раз на все процессы — lock) */
export async function ensureTelegramProxy() {
    const proxyUrl = resolveTelegramProxyUrl();
    if (!proxyUrl) {
        console.log('[Telegram] без прокси (TELEGRAM_PROXY=off)');
        return true;
    }

    if (await isTelegramProxyReachable(proxyUrl)) {
        console.log(`[Telegram] прокси доступен: ${proxyUrl}`);
        return true;
    }

    if (process.env.TELEGRAM_AUTO_XRAY === 'off') {
        console.error(`[Telegram] прокси недоступен: ${proxyUrl} (TELEGRAM_AUTO_XRAY=off)`);
        return false;
    }

    let lockFd;
    try {
        const { open } = await import('fs/promises');
        lockFd = await open(XRAY_LOCK, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    } catch {
        console.log('[Telegram] xray уже запускается другим процессом, жду…');
        for (let i = 0; i < 24; i++) {
            await sleep(5000);
            if (await isTelegramProxyReachable(proxyUrl)) {
                console.log(`[Telegram] прокси поднялся: ${proxyUrl}`);
                return true;
            }
        }
        console.error('[Telegram] таймаут ожидания xray');
        return false;
    }

    try {
        if (await isTelegramProxyReachable(proxyUrl)) {
            return true;
        }
        await runXrayScript();
        for (let i = 0; i < 12; i++) {
            await sleep(2000);
            if (await isTelegramProxyReachable(proxyUrl)) {
                console.log(`[Telegram] xray поднял прокси: ${proxyUrl}`);
                return true;
            }
        }
        console.error('[Telegram] xray.sh отработал, но порт всё ещё недоступен — bash xray-check.sh');
        return false;
    } catch (error) {
        console.error('[Telegram] не удалось запустить xray.sh:', error.message);
        return false;
    } finally {
        try {
            await lockFd?.close();
        } catch {}
        await unlink(XRAY_LOCK).catch(() => {});
    }
}

export function buildTelegramBotOptions() {
    const proxyUrl = resolveTelegramProxyUrl();
    if (!proxyUrl) {
        return { polling: true };
    }

    const lower = proxyUrl.toLowerCase();
    const request = {};

    if (lower.startsWith('http://') || lower.startsWith('https://')) {
        request.proxy = proxyUrl;
    } else {
        request.agent = new SocksProxyAgent(proxyUrl);
    }

    return { polling: true, request };
}

let lastPollingErrorLog = 0;

export function attachTelegramDiagnostics(bot) {
    bot.on('polling_error', async (error) => {
        const now = Date.now();
        if (now - lastPollingErrorLog < 30_000) {
            return;
        }
        lastPollingErrorLog = now;
        console.error('[Telegram polling_error]', error.code || '', error.message);

        if (
            process.env.TELEGRAM_AUTO_XRAY !== 'off' &&
            String(error.message).includes('ECONNREFUSED')
        ) {
            await ensureTelegramProxy();
        }
    });
}
