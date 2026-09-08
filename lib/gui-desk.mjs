import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { viewPortFromIp } from './bot-view/install.mjs';
import {
    applyDeskEvacuate,
    noteDeskAnydesk,
    registerDeskVerify,
    resumeAfterDeskSession,
} from '../orchestrator-shared.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function envFile() {
    try {
        return readFileSync(join(ROOT, '.gui-desk.env'), 'utf8');
    } catch {
        return '';
    }
}

function envVal(name, fallback = '') {
    const fromProc = String(process.env[name] || '').trim();
    if (fromProc) return fromProc;
    const raw = envFile();
    const re = new RegExp(`^${name}=(.*)$`, 'm');
    const m = raw.match(re);
    if (!m) return fallback;
    return m[1].trim().replace(/^['"]|['"]$/g, '');
}

const GUI_DESK_WS = envVal('GUI_DESK_WS', 'ws://90.156.168.156:26081').replace(/\/$/, '');
const TOKEN = envVal('GUI_VIEW_TOKEN');
const FARM_HOST = envVal('FARM_VIEW_HOST', '212.8.229.76');

let getCtx = null;
let ws = null;
let reconnectTimer = null;
let pingTimer = null;

function wsUrl() {
    const u = new URL(GUI_DESK_WS);
    if (TOKEN) u.searchParams.set('token', TOKEN);
    return u.toString();
}

function postStay(ctx, username, msg) {
    const entry = ctx.workers?.get(username);
    if (!entry?.worker || entry.worker.terminated) return false;
    try {
        entry.worker.postMessage(msg);
        return true;
    } catch {
        return false;
    }
}

function onMessage(raw) {
    let msg;
    try {
        msg = JSON.parse(String(raw));
    } catch {
        return;
    }
    const ctx = typeof getCtx === 'function' ? getCtx() : null;
    if (!ctx) return;
    const type = msg.type;
    if (type === 'evacuate') {
        applyDeskEvacuate(msg.stay, ctx, {
            from: 'gui',
            reason: msg.reason || '',
        });
        return;
    }
    if (type === 'anydesk') {
        const id = String(msg.id || '').replace(/\D/g, '');
        const nick = String(msg.username || '').trim();
        noteDeskAnydesk(ctx);
        if (nick && id) {
            postStay(ctx, nick, { type: 'anydesk_id', id });
            console.log(`[gui-desk] anydesk ${id} → ${nick}`);
        }
        return;
    }
    if (type === 'session_end') {
        console.log('[gui-desk] session_end');
        resumeAfterDeskSession(ctx);
        return;
    }
    if (type === 'busy') {
        const stay = msg.stay || '?';
        void ctx.sendAlert?.(
            `GUI AnyDesk занят (stay ${stay}) — новая проверка ${msg.username || ''} без подключения`,
        );
        return;
    }
    if (type === 'verify_fail') {
        void ctx.sendAlert?.(
            `GUI не подключился к ${msg.username || '?'}: ${msg.error || 'fail'}`,
        );
    }
}

function sendVerify(username, ctx) {
    const bot = ctx?.bots?.get(username);
    const port = Number(bot?.viewPort) || viewPortFromIp(bot?.ip);
    if (!port) {
        console.warn(`[gui-desk] нет view-порта у ${username}`);
        void ctx?.sendAlert?.(`проверка ${username}: нет view-порта, TLauncher некуда заходить`);
        return false;
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('[gui-desk] WS не подключён');
        return false;
    }
    const payload = {
        type: 'verify',
        username,
        host: FARM_HOST,
        port,
        anarchy: bot?.anarchy ?? null,
    };
    try {
        ws.send(JSON.stringify(payload));
        console.log(`[gui-desk] verify ${username} ${FARM_HOST}:${port}`);
        return true;
    } catch (err) {
        console.warn(`[gui-desk] send: ${err?.message || err}`);
        return false;
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, 4000);
}

function connect() {
    if (!TOKEN) {
        console.warn('[gui-desk] нет GUI_VIEW_TOKEN — проверка AnyDesk выкл');
        return;
    }
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
    }
    const url = wsUrl();
    let sock;
    try {
        sock = new WebSocket(url, { handshakeTimeout: 8000 });
    } catch (err) {
        console.warn(`[gui-desk] ${err?.message || err}`);
        scheduleReconnect();
        return;
    }
    ws = sock;
    sock.on('open', () => {
        console.log(`[gui-desk] WS ${GUI_DESK_WS}`);
        if (pingTimer) clearInterval(pingTimer);
        pingTimer = setInterval(() => {
            if (sock.readyState === WebSocket.OPEN) {
                try { sock.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ }
            }
        }, 25000);
        pingTimer.unref?.();
    });
    sock.on('message', onMessage);
    sock.on('close', () => {
        if (ws === sock) ws = null;
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
        scheduleReconnect();
    });
    sock.on('error', (err) => {
        console.warn(`[gui-desk] ${err?.message || err}`);
    });
}

export function startGuiDeskClient(factory) {
    getCtx = factory;
    registerDeskVerify(sendVerify);
    connect();
}
