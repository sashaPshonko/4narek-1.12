#!/usr/bin/env node
/**
 * Локальный прогон 4NAREK.mjs (ванильный стек как в 4narek-old: input-only WASD, physics OFF).
 *
 * Пример:
 *   node scripts/run-4narek-local.mjs \
 *     --user Nick --pass secret --an 502 \
 *     --proxy 'socks5://user:pass@host:port' \
 *     --item 'netherite sword' --goType netherite_sword-1.21
 *
 * Pilot + запись мыши/ходьбы:
 *   VIEW_PILOT=1 VIEW_RECORD=1 VIEW_PORT=25501 \
 *     node scripts/run-4narek-local.mjs --user … --pass … --proxy … --ip local
 *   → TLauncher: 127.0.0.1:25501  (см. lib/bot-view/PILOT.md)
 *
 * Или env: NAREK_USER NAREK_PASS NAREK_AN NAREK_PROXY NAREK_ITEM NAREK_GO_TYPE
 */
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function arg(name, envName, fallback = '') {
    const flag = `--${name}`;
    const i = process.argv.indexOf(flag);
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    if (envName && process.env[envName]) return process.env[envName];
    return fallback;
}

const username = arg('user', 'NAREK_USER');
const password = arg('pass', 'NAREK_PASS');
const anarchy = Number(arg('an', 'NAREK_AN', '502'));
const proxyUrl = arg('proxy', 'NAREK_PROXY');
const item = arg('item', 'NAREK_ITEM', 'netherite sword');
const goType = arg('goType', 'NAREK_GO_TYPE', 'netherite_sword-1.21');
const ip = arg('ip', 'NAREK_IP', 'local');

if (!username || !password || !proxyUrl) {
    console.error(`usage: node scripts/run-4narek-local.mjs --user NICK --pass PASS --an 502 --proxy 'socks5://u:p@host:port'`);
    process.exit(2);
}

const workerData = {
    username,
    password,
    anarchy,
    type: '4NAREK',
    item,
    goType,
    ip,
    proxyUrl,
    itemPrices: [],
    catalogAll: [],
    role: 'local',
};

const pilot = process.env.VIEW_PILOT === '1' || process.env.VIEW_PILOT === 'true';
const viewPort = process.env.VIEW_PORT || (pilot || ip === 'local' ? '25501' : '');
if (viewPort && !process.env.VIEW_PORT) process.env.VIEW_PORT = viewPort;

console.log(`[local] start ${username} an${anarchy} item=${item}`);
console.log(`[local] proxy ${proxyUrl.replace(/:[^:@/]+@/, ':***@')}`);
if (pilot) {
    console.log(`[local] PILOT on → TLauncher 127.0.0.1:${process.env.VIEW_PORT || 25501}`);
    console.log(`[local] cmds: !rec start|stop | !pilot on|off  → motion-records/`);
}

const worker = new Worker(join(root, '4NAREK.mjs'), {
    workerData,
    env: { ...process.env },
    resourceLimits: { maxOldGenerationSizeMb: 384 },
});

worker.on('message', (msg) => {
    if (msg && typeof msg === 'object' && msg.name) {
        console.log(`[worker:${username}]`, msg.name, msg.username || msg.port || msg.reason || '');
        return;
    }
    console.log(`[worker:${username}]`, msg);
});

worker.on('error', (err) => {
    console.error(`[worker:${username}] error`, err);
});

worker.on('exit', (code) => {
    console.log(`[worker:${username}] exit ${code}`);
    process.exit(code || 0);
});

process.on('SIGINT', () => {
    console.log('[local] SIGINT → terminate worker');
    try {
        worker.terminate();
    } catch {
        /* ignore */
    }
});
