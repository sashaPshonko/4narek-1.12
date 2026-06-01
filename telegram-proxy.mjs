import net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';
import { access, readFile, unlink } from 'fs/promises';
import { constants } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SocksProxyAgent } from 'socks-proxy-agent';

const execAsync = promisify(exec);
const __proxyDir = dirname(fileURLToPath(import.meta.url));
const XRAY_SCRIPT = join(__proxyDir, 'xray.sh');
const XRAY_LOCK = '/tmp/4narek-xray-start.lock';
const VLESS_STAMP = '/opt/xray/vless-url.stamp';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** TELEGRAM_PROXY=socks5h://127.0.0.1:1080 | http://127.0.0.1:1080 | off */
export function resolveTelegramProxyUrl() {
    const value = process.env.TELEGRAM_PROXY;
    if (value === 'off' || value === '0' || value === 'false') {
        return null;
    }
    return value || 'socks5h://127.0.0.1:1080';
}

/** Ссылка из константы VLESS_URL в xray.sh (после git pull) */
export async function readDesiredVlessUrl() {
    const sh = await readFile(XRAY_SCRIPT, 'utf8');
    const m = sh.match(/^VLESS_URL=(?:(['"])(.*?)\1)/m);
    if (!m?.[2]) {
        throw new Error('VLESS_URL не найден в xray.sh');
    }
    return m[2];
}

async function readAppliedVlessStamp() {
    try {
        return (await readFile(VLESS_STAMP, 'utf8')).trim();
    } catch {
        return '';
    }
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

/** Реально ли Telegram API отвечает через SOCKS (не только открытый порт) */
export async function isTelegramApiOkViaProxy(proxyUrl, timeoutMs = 12_000) {
    const lower = proxyUrl.toLowerCase();
    try {
        if (lower.startsWith('http://') || lower.startsWith('https://')) {
            await execAsync(
                `curl -sf --max-time ${Math.ceil(timeoutMs / 1000)} -x ${JSON.stringify(proxyUrl)} -o /dev/null https://api.telegram.org`,
            );
            return true;
        }
        const agent = new SocksProxyAgent(proxyUrl);
        const res = await fetch('https://api.telegram.org', {
            agent,
            signal: AbortSignal.timeout(timeoutMs),
        });
        return res.status > 0;
    } catch {
        return false;
    }
}

/** Нужен перезапуск xray: новая ссылка в репо, нет порта, или TG не ходит */
export async function proxyNeedsXrayRefresh(proxyUrl) {
    const desired = await readDesiredVlessUrl();
    const applied = await readAppliedVlessStamp();

    if (desired !== applied) {
        console.log('[Telegram] VLESS_URL в xray.sh изменился — нужен xray.sh');
        return true;
    }

    if (!(await isTelegramProxyReachable(proxyUrl))) {
        return true;
    }

    if (!(await isTelegramApiOkViaProxy(proxyUrl))) {
        console.log('[Telegram] SOCKS есть, но api.telegram.org не отвечает — нужен xray.sh');
        return true;
    }

    return false;
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

async function waitForProxyReady(proxyUrl, attempts = 12, intervalMs = 2000) {
    for (let i = 0; i < attempts; i++) {
        if (!(await proxyNeedsXrayRefresh(proxyUrl))) {
            return true;
        }
        await sleep(intervalMs);
    }
    return false;
}

async function startXrayWithLock(proxyUrl) {
    let lockFd;
    try {
        const { open } = await import('fs/promises');
        lockFd = await open(XRAY_LOCK, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    } catch {
        console.log('[Telegram] xray уже запускается другим процессом, жду…');
        for (let i = 0; i < 30; i++) {
            if (await waitForProxyReady(proxyUrl, 1, 5000)) {
                console.log(`[Telegram] прокси готов: ${proxyUrl}`);
                return true;
            }
        }
        console.error('[Telegram] таймаут ожидания xray');
        return false;
    }

    try {
        await runXrayScript();
        if (await waitForProxyReady(proxyUrl)) {
            console.log(`[Telegram] xray поднял прокси: ${proxyUrl}`);
            return true;
        }
        console.error('[Telegram] xray.sh отработал, но прокси не готов — bash xray-check.sh');
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

/**
 * Поднять/обновить SOCKS через xray.sh.
 * После git pull достаточно рестарта оркестратора — увидит новый VLESS_URL в xray.sh.
 */
export async function ensureTelegramProxy() {
    const proxyUrl = resolveTelegramProxyUrl();
    if (!proxyUrl) {
        console.log('[Telegram] без прокси (TELEGRAM_PROXY=off)');
        return true;
    }

    if (process.env.TELEGRAM_AUTO_XRAY === 'off') {
        const ok = await isTelegramProxyReachable(proxyUrl);
        if (!ok) {
            console.error(`[Telegram] прокси недоступен: ${proxyUrl} (TELEGRAM_AUTO_XRAY=off)`);
        }
        return ok;
    }

    if (!(await proxyNeedsXrayRefresh(proxyUrl))) {
        console.log(`[Telegram] прокси OK: ${proxyUrl}`);
        return true;
    }

    return startXrayWithLock(proxyUrl);
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

        if (process.env.TELEGRAM_AUTO_XRAY === 'off') {
            return;
        }

        const msg = String(error.message || '');
        const retryable =
            /ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up|ENOTFOUND|EAI_AGAIN|TLS|fetch failed|proxy/i.test(
                msg,
            );
        if (retryable) {
            await ensureTelegramProxy();
        }
    });
}
