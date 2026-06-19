#!/usr/bin/env node
/**
 * Кроссплатформенный Xray (Windows + Linux/macOS).
 * vless.url или xray.local.env → SOCKS 127.0.0.1:1080
 *
 *   node xray.mjs
 *   node xray-check.mjs
 */
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import {
    access,
    mkdir,
    readFile,
    writeFile,
    chmod,
    open,
    constants,
} from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform, arch } from 'os';
import {
    parseVlessUrl,
    buildXrayConfig,
    readVlessFromRepoFile,
    readVlessFromEnvFile,
} from './lib/vless.mjs';
import { SocksProxyAgent } from 'socks-proxy-agent';

const execFileAsync = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(ROOT, '.xray-runtime');
const ENV_FILE = join(ROOT, 'xray.local.env');
const VLESS_REPO_FILE = join(ROOT, 'vless.url');
const STAMP_FILE = join(ROOT, '.vless-applied.stamp');
const SOCKS_PORT = Number(process.env.XRAY_SOCKS_PORT || 1080);
const PROXY_URL = process.env.TELEGRAM_PROXY || `socks5h://127.0.0.1:${SOCKS_PORT}`;

function xrayAssetName() {
    const p = platform();
    const a = arch();
    if (p === 'win32') {
        return a === 'arm64' ? 'Xray-windows-arm64-v8a.zip' : 'Xray-windows-64.zip';
    }
    if (p === 'darwin') {
        return a === 'arm64' ? 'Xray-macos-arm64-v8a.zip' : 'Xray-macos-64.zip';
    }
    if (a === 'arm64') return 'Xray-linux-arm64-v8a.zip';
    return 'Xray-linux-64.zip';
}

function xrayBinaryName() {
    return platform() === 'win32' ? 'xray.exe' : 'xray';
}

function paths() {
    const bin = join(RUNTIME, xrayBinaryName());
    return {
        bin,
        config: join(RUNTIME, 'config.json'),
        log: join(RUNTIME, 'xray.log'),
        zip: join(RUNTIME, xrayAssetName()),
    };
}

async function readDesiredVlessUrl() {
    const fromRepo = await readVlessFromRepoFile(VLESS_REPO_FILE);
    if (fromRepo) return fromRepo;
    const fromEnv = await readVlessFromEnvFile(ENV_FILE);
    if (fromEnv) return fromEnv;
    throw new Error(
        'Нет vless.url и нет xray.local.env — cp xray.local.env.example xray.local.env',
    );
}

async function downloadXray(zipPath, assetName) {
    console.log(`📥 Скачиваем Xray (${assetName})…`);
    const api = await fetch('https://api.github.com/repos/XTLS/Xray-core/releases/latest');
    if (!api.ok) {
        throw new Error(`GitHub releases: HTTP ${api.status}`);
    }
    const release = await api.json();
    const asset = release.assets?.find((a) => a.name === assetName);
    if (!asset?.browser_download_url) {
        throw new Error(`Нет ассета ${assetName} в последнем релизе Xray`);
    }
    const res = await fetch(asset.browser_download_url);
    if (!res.ok) {
        throw new Error(`Скачивание: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(zipPath, buf);
}

async function extractZip(zipPath, destDir) {
    const p = platform();
    if (p === 'win32') {
        await execFileAsync(
            'powershell',
            [
                '-NoProfile',
                '-Command',
                `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(destDir)} -Force`,
            ],
            { timeout: 120_000 },
        );
        return;
    }
    try {
        await execFileAsync('unzip', ['-o', zipPath, '-d', destDir], { timeout: 120_000 });
    } catch {
        await execFileAsync('tar', ['-xf', zipPath, '-C', destDir], { timeout: 120_000 });
    }
}

async function ensureBinary() {
    const { bin, zip } = paths();
    try {
        await access(bin, platform() === 'win32' ? constants.F_OK : constants.X_OK);
        return bin;
    } catch {
        /* download */
    }

    await mkdir(RUNTIME, { recursive: true });
    const assetName = xrayAssetName();
    await downloadXray(zip, assetName);
    await extractZip(zip, RUNTIME);
    if (platform() !== 'win32') {
        await chmod(bin, 0o755);
    }
    return bin;
}

async function stopXray() {
    const { bin } = paths();
    if (platform() === 'win32') {
        try {
            await execFileAsync('taskkill', ['/F', '/IM', xrayBinaryName()], { timeout: 10_000 });
        } catch {
            /* not running */
        }
        return;
    }
    try {
        await execFileAsync('pkill', ['-x', 'xray'], { timeout: 10_000 });
    } catch {
        /* not running */
    }
    try {
        await access(bin, constants.F_OK);
        await execFileAsync(bin, ['stop'], { timeout: 5000 });
    } catch {
        /* ignore */
    }
}

async function writeConfig(vlessUrl) {
    const parsed = parseVlessUrl(vlessUrl);
    console.log(
        `Параметры: server=${parsed.addr}:${parsed.port} security=${parsed.security} network=${parsed.network}`,
    );
    const config = buildXrayConfig(parsed, SOCKS_PORT);
    const { config: configPath } = paths();
    await mkdir(RUNTIME, { recursive: true });
    await writeFile(configPath, JSON.stringify(config, null, 2));
    return configPath;
}

async function testConfig(bin, configPath) {
    console.log('🔍 Проверка конфига…');
    const { stdout, stderr } = await execFileAsync(
        bin,
        ['run', '-test', '-c', configPath],
        { timeout: 30_000 },
    );
    const out = `${stdout || ''}${stderr || ''}`.trim();
    if (out) console.log(out);
}

async function startXrayProcess(bin, configPath) {
    const { log } = paths();
    console.log('🚀 Запуск xray…');
    await stopXray();
    await new Promise((r) => setTimeout(r, 800));

    const logFd = await open(log, 'a');
    const child = spawn(bin, ['run', '-c', configPath], {
        detached: true,
        stdio: ['ignore', logFd.fd, logFd.fd],
        windowsHide: true,
    });
    child.unref();
    await logFd.close();
    await new Promise((r) => setTimeout(r, 2000));
}

async function isPortOpen(port, host = '127.0.0.1', timeoutMs = 2000) {
    const net = await import('net');
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

async function isTelegramApiOkViaProxy(proxyUrl) {
    try {
        const agent = new SocksProxyAgent(proxyUrl);
        const res = await fetch('https://api.telegram.org', {
            agent,
            signal: AbortSignal.timeout(12_000),
        });
        return res.status > 0;
    } catch {
        return false;
    }
}

async function main() {
    const vlessUrl = await readDesiredVlessUrl();
    const bin = await ensureBinary();
    const configPath = await writeConfig(vlessUrl);
    await testConfig(bin, configPath);
    await startXrayProcess(bin, configPath);

    if (!(await isPortOpen(SOCKS_PORT))) {
        const { log } = paths();
        let tail = '';
        try {
            const lines = (await readFile(log, 'utf8')).split('\n').slice(-40);
            tail = lines.join('\n');
        } catch {
            /* empty */
        }
        console.error(`❌ Порт ${SOCKS_PORT} не слушается`);
        if (tail) console.error(tail);
        process.exit(1);
    }

    console.log(`✅ Порт ${SOCKS_PORT} слушается`);
    if (await isTelegramApiOkViaProxy(PROXY_URL)) {
        console.log('✅ Telegram API через прокси OK');
    } else {
        console.warn('⚠️ SOCKS есть, Telegram не ответил — node xray-check.mjs');
    }

    await writeFile(STAMP_FILE, vlessUrl, { mode: 0o600 });
    console.log('✅ Готово. Перезапусти оркестратор или дождись автоподнятия xray.');
}

main().catch((e) => {
    console.error(`❌ ${e.message}`);
    process.exit(1);
});
