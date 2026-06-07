import net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';
import { access, readFile, unlink, writeFile } from 'fs/promises';
import { constants } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { SocksProxyAgent } from 'socks-proxy-agent';

const execAsync = promisify(exec);
const __proxyDir = dirname(fileURLToPath(import.meta.url));
const XRAY_SCRIPT = join(__proxyDir, 'xray.sh');
const XRAY_ENV_FILE = join(__proxyDir, 'xray.local.env');
const VLESS_REPO_FILE = join(__proxyDir, 'vless.url');
const XRAY_LOCK = '/tmp/4narek-xray-start.lock';
const VLESS_STAMP = join(__proxyDir, '.vless-applied.stamp');
const VLESS_STAMP_LEGACY = '/opt/xray/vless-url.stamp';
const XRAY_RETRY_COOLDOWN_MS = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastFailedXrayAt = 0;
let lastRefreshReason = '';
let lastRefreshReasonAt = 0;

/** TELEGRAM_PROXY=socks5h://127.0.0.1:1080 | http://127.0.0.1:1080 | off */
export function resolveTelegramProxyUrl() {
    const value = process.env.TELEGRAM_PROXY;
    if (value === 'off' || value === '0' || value === 'false') {
        return null;
    }
    return value || 'socks5h://127.0.0.1:1080';
}

function parseVlessUrlLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
        return null;
    }
    if (trimmed.startsWith('vless://')) {
        return trimmed;
    }
    const m = trimmed.match(/^VLESS_URL=(?:(['"])(.*?)\1|(\S+))/);
    return m?.[2] ?? m?.[3] ?? null;
}

/** VLESS из vless.url в репо (git pull → /update) */
export async function readVlessFromRepoFile() {
    try {
        const raw = await readFile(VLESS_REPO_FILE, 'utf8');
        for (const line of raw.split('\n')) {
            const url = parseVlessUrlLine(line);
            if (url) {
                return url;
            }
        }
    } catch {
        /* fall through */
    }
    return null;
}

/** vless.url → xray.local.env (xray.sh читает env-файл) */
export async function syncVlessFromRepo() {
    const url = await readVlessFromRepoFile();
    if (!url) {
        return false;
    }
    const envContent = `VLESS_URL='${url}'\n`;
    let current = '';
    try {
        current = await readFile(XRAY_ENV_FILE, 'utf8');
    } catch {
        /* новый файл */
    }
    if (current === envContent) {
        return false;
    }
    await writeFile(XRAY_ENV_FILE, envContent, { mode: 0o600 });
    console.log('[Telegram] vless.url → xray.local.env');
    return true;
}

/** VLESS: сначала vless.url из репо, иначе xray.local.env на VPS */
export async function readDesiredVlessUrl() {
    const fromRepo = await readVlessFromRepoFile();
    if (fromRepo) {
        return fromRepo;
    }
    try {
        const env = await readFile(XRAY_ENV_FILE, 'utf8');
        const m = env.match(/^VLESS_URL=(?:(['"])(.*?)\1|(\S+))/m);
        if (m?.[2] || m?.[3]) {
            return m[2] ?? m[3];
        }
    } catch {
        /* fall through */
    }
    throw new Error(
        'Нет vless.url в репо и нет xray.local.env — добавь vless.url и git push',
    );
}

async function readAppliedVlessStamp() {
    for (const path of [VLESS_STAMP, VLESS_STAMP_LEGACY]) {
        try {
            return (await readFile(path, 'utf8')).trim();
        } catch {
            /* try next */
        }
    }
    return '';
}

async function markVlessApplied(url) {
    await writeFile(VLESS_STAMP, url, { mode: 0o600 });
}

function logRefreshReasonOnce(reason) {
    const now = Date.now();
    if (reason === lastRefreshReason && now - lastRefreshReasonAt < 60_000) {
        return;
    }
    lastRefreshReason = reason;
    lastRefreshReasonAt = now;
    console.log(`[Telegram] ${reason}`);
}

/** Проверка без логов (вызывается в цикле ожидания) */
async function checkProxyNeedsRefresh(proxyUrl) {
    const desired = await readDesiredVlessUrl();
    const applied = await readAppliedVlessStamp();

    if (desired !== applied) {
        return 'vless изменился';
    }

    if (!(await isTelegramProxyReachable(proxyUrl))) {
        return 'SOCKS 1080 недоступен';
    }

    if (!(await isTelegramApiOkViaProxy(proxyUrl))) {
        return 'api.telegram.org не отвечает через прокси';
    }

    return null;
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

/** Нужен перезапуск xray: новая ссылка, нет порта, или TG не ходит */
export async function proxyNeedsXrayRefresh(proxyUrl) {
    return (await checkProxyNeedsRefresh(proxyUrl)) !== null;
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
        const reason = await checkProxyNeedsRefresh(proxyUrl);
        if (!reason) {
            const desired = await readDesiredVlessUrl();
            await markVlessApplied(desired);
            return true;
        }
        await sleep(intervalMs);
    }
    return false;
}

async function startXrayWithLock(proxyUrl) {
    const reason = await checkProxyNeedsRefresh(proxyUrl);
    if (!reason) {
        return true;
    }
    logRefreshReasonOnce(`${reason} — запускаю xray.sh…`);
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
            lastFailedXrayAt = 0;
            console.log(`[Telegram] xray поднял прокси: ${proxyUrl}`);
            return true;
        }
        lastFailedXrayAt = Date.now();
        console.error('[Telegram] xray.sh отработал, но прокси не готов — bash xray-check.sh');
        return false;
    } catch (error) {
        lastFailedXrayAt = Date.now();
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
 * vless.url из git → xray.local.env → xray.sh (в т.ч. после /update).
 */
export async function ensureTelegramProxy() {
    const proxyUrl = resolveTelegramProxyUrl();
    if (!proxyUrl) {
        console.log('[Telegram] без прокси (TELEGRAM_PROXY=off)');
        return true;
    }

    await syncVlessFromRepo();

    if (process.env.TELEGRAM_AUTO_XRAY === 'off') {
        const ok = await isTelegramProxyReachable(proxyUrl);
        if (!ok) {
            console.error(`[Telegram] прокси недоступен: ${proxyUrl} (TELEGRAM_AUTO_XRAY=off)`);
        }
        return ok;
    }

    const refreshReason = await checkProxyNeedsRefresh(proxyUrl);
    if (refreshReason === 'vless изменился') {
        const reachable = await isTelegramProxyReachable(proxyUrl);
        if (reachable && (await isTelegramApiOkViaProxy(proxyUrl))) {
            await markVlessApplied(await readDesiredVlessUrl());
            console.log(`[Telegram] прокси OK: ${proxyUrl}`);
            return true;
        }
    }

    if (!refreshReason) {
        console.log(`[Telegram] прокси OK: ${proxyUrl}`);
        return true;
    }

    if (Date.now() - lastFailedXrayAt < XRAY_RETRY_COOLDOWN_MS) {
        return false;
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
let lastPollingProxyRetryAt = 0;

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
        if (retryable && now - lastPollingProxyRetryAt >= XRAY_RETRY_COOLDOWN_MS) {
            lastPollingProxyRetryAt = now;
            await ensureTelegramProxy();
        }
    });
}
