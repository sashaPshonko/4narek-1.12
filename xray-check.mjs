#!/usr/bin/env node
import { readFile, access, constants } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import { SocksProxyAgent } from 'socks-proxy-agent';

const execFileAsync = promisify(execFile);
const ROOT = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(ROOT, '.xray-runtime');
const SOCKS_PORT = Number(process.env.XRAY_SOCKS_PORT || 1080);
const binName = platform() === 'win32' ? 'xray.exe' : 'xray';
const BIN = join(RUNTIME, binName);
const CONFIG = join(RUNTIME, 'config.json');
const LOG = join(RUNTIME, 'xray.log');

function portOpen(port) {
    return new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port });
        const done = (ok) => {
            s.destroy();
            resolve(ok);
        };
        s.setTimeout(2000);
        s.once('connect', () => done(true));
        s.once('timeout', () => done(false));
        s.once('error', () => done(false));
    });
}

async function main() {
    console.log(`=== порт ${SOCKS_PORT} ===`);
    console.log((await portOpen(SOCKS_PORT)) ? 'слушается' : 'ничего не слушает');

    console.log('=== процесс xray ===');
    if (platform() === 'win32') {
        try {
            const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq xray.exe']);
            console.log(stdout.includes('xray.exe') ? stdout.split('\n').find((l) => l.includes('xray')) : 'xray не запущен');
        } catch {
            console.log('xray не запущен');
        }
    } else {
        try {
            const { stdout } = await execFileAsync('pgrep', ['-a', 'xray']);
            console.log(stdout.trim() || 'xray не запущен');
        } catch {
            console.log('xray не запущен');
        }
    }

    console.log('=== бинарник ===');
    try {
        await access(BIN, constants.F_OK);
        console.log(BIN);
    } catch {
        console.log(`нет ${BIN} — запусти: node xray.mjs`);
    }

    console.log('=== тест конфига ===');
    try {
        const { stdout, stderr } = await execFileAsync(BIN, ['run', '-test', '-c', CONFIG], {
            timeout: 15_000,
        });
        console.log(`${stdout}${stderr}`.trim() || 'ok');
    } catch (e) {
        console.log(e.message);
    }

    console.log('=== последние 40 строк лога ===');
    try {
        const lines = (await readFile(LOG, 'utf8')).split('\n').slice(-40);
        console.log(lines.join('\n') || '(лог пуст)');
    } catch {
        console.log('лог пуст');
    }

    console.log('=== Telegram через SOCKS ===');
    try {
        const agent = new SocksProxyAgent(`socks5h://127.0.0.1:${SOCKS_PORT}`);
        const res = await fetch('https://api.telegram.org', {
            agent,
            signal: AbortSignal.timeout(12_000),
        });
        console.log(`http_status=${res.status}`);
    } catch (e) {
        console.log(`failed: ${e.message}`);
    }
}

main();
