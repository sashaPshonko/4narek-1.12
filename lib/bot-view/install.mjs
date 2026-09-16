import { parentPort } from 'worker_threads';
import { createPacketCache } from './cache.mjs';
import { startAttachServer } from './attach.mjs';
import { tapClientPackets, shouldForwardLiveWire } from './wire.mjs';
import { createPilot, parsePilotChatCommand } from './pilot.mjs';
import { createMotionRecorder } from './recorder.mjs';

export const VIEW_HUB_HTTP = 'http://127.0.0.1:25999';

/** `504-2` → 25042. Слушаем 0.0.0.0 — GUI VPS заходит на публичный IP фермы. */
export function viewPortFromIp(ip) {
    if (process.env.VIEW_PORT) {
        const n = Number(process.env.VIEW_PORT);
        if (Number.isFinite(n) && n > 0) return n;
    }
    const m = String(ip || '').match(/^(\d+)-(\d+)$/);
    if (!m) {
        // local / произвольный ip — дефолтный порт для записи
        if (String(ip || '').toLowerCase() === 'local' || process.env.VIEW_PILOT === '1') {
            return 25501;
        }
        return null;
    }
    return 20000 + Number(m[1]) * 10 + Number(m[2]);
}

export const VIEW_BIND = String(process.env.VIEW_BIND || '0.0.0.0');

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
 * Зритель TLauncher. Сессия FunTime не трогается.
 * По умолчанию: чат → бот, движение нет.
 * Pilot (VIEW_PILOT=1 или opts.pilot): look + player_input → бот; !pilot / !rec в чате.
 */
export function installBotView(bot, {
    username,
    ip,
    anarchy,
    log = console.log,
    onSpectatorChat,
    pilot: pilotOpt = null,
    ensurePhysicsOn = null,
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

    const wantPilot = pilotOpt === true
        || pilotOpt === '1'
        || process.env.VIEW_PILOT === '1'
        || process.env.VIEW_PILOT === 'true';
    const autoRec = process.env.VIEW_RECORD === '1' || process.env.VIEW_RECORD === 'true';

    const cache = createPacketCache();
    let attach = null;
    let lastChatAt = 0;

    const recorder = createMotionRecorder({ log: (m) => log(`view ${m}`) });
    const pilot = createPilot(bot, {
        log: (m) => log(`view ${m}`),
        allowSprint: process.env.VIEW_PILOT_SPRINT === '1',
        ensurePhysicsOn: typeof ensurePhysicsOn === 'function'
            ? ensurePhysicsOn
            : (b) => { if (b) b.physicsEnabled = true; },
    });

    // 20 Hz сэмплы пока пилот + запись
    const tickSample = () => {
        if (!pilot.isEnabled() || !recorder.isRecording()) return;
        recorder.sampleFromBot(bot, pilot.getControls());
    };
    bot.on('physicsTick', tickSample);

    function replyPilotHelp() {
        log('view cmds: !pilot on|off | !rec start [tag] | !rec stop | !rec status | !help');
    }

    function handlePilotCommand(cmd) {
        if (!cmd) return false;
        if (cmd.type === 'help') {
            replyPilotHelp();
            return true;
        }
        if (cmd.type === 'pilot') {
            pilot.setEnabled(cmd.on);
            return true;
        }
        if (cmd.type === 'pilot_toggle') {
            pilot.setEnabled(!pilot.isEnabled());
            return true;
        }
        if (cmd.type === 'rec_start') {
            if (!pilot.isEnabled()) pilot.setEnabled(true);
            recorder.start(cmd.tag || 'walk');
            return true;
        }
        if (cmd.type === 'rec_stop') {
            recorder.stop();
            return true;
        }
        if (cmd.type === 'rec_status') {
            log(`view rec ${JSON.stringify(recorder.status())} pilot=${pilot.isEnabled()}`);
            return true;
        }
        if (cmd.type === 'rec_toggle') {
            if (recorder.isRecording()) recorder.stop();
            else {
                if (!pilot.isEnabled()) pilot.setEnabled(true);
                recorder.start(cmd.tag || 'walk');
            }
            return true;
        }
        return false;
    }

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
        host: VIEW_BIND,
        port,
        version: '1.21.11',
        motd: wantPilot ? `pilot · ${username}` : `view · ${username}`,
        cache,
        getBot: () => bot,
        onSpectatorChat: (text, from) => {
            const now = Date.now();
            if (now - lastChatAt < 250) return;
            lastChatAt = now;
            const cmd = parsePilotChatCommand(text);
            if (cmd && handlePilotCommand(cmd)) return;
            if (typeof onSpectatorChat === 'function') onSpectatorChat(text, from);
            else {
                try { bot.chat(text); } catch { /* ignore */ }
            }
        },
        onSpectatorPlayPacket: (name, data) => {
            pilot.handleSpectatorPacket(name, data);
        },
        log,
    });

    // при входе зрителя — автопилот/запись по env
    const origJoinHook = () => {
        /* spectators set is internal; use MOTD + first packet */
    };
    void origJoinHook;

    if (wantPilot) {
        // включим при первом motion-пакете или сразу
        pilot.setEnabled(true);
        log(`view: PILOT mode port=${port} (!pilot / !rec)`);
        if (autoRec) {
            recorder.start(`an${anarchy || 'x'}_${username || 'bot'}`);
        }
    }

    bot._client.on('start_configuration', () => {
        attach.beginWorldChange().catch((err) => log(`view beginWorld: ${err?.message || err}`));
    });
    bot._client.on('login', () => {
        attach.finishWorldChange().catch((err) => log(`view finishWorld: ${err?.message || err}`));
    });
    bot.on('end', () => {
        recorder.stop();
        pilot.dispose();
        attach.kickAll('бот отключился');
    });
    bot.on('kicked', () => {
        recorder.stop();
        pilot.dispose();
        attach.kickAll('бот кикнут');
    });

    const payload = { username, port, anarchy: Number(anarchy) || null, pilot: wantPilot };
    registerHub(payload);
    const hubTimer = setInterval(() => registerHub(payload), 15000);
    hubTimer.unref?.();
    bot.on('end', () => clearInterval(hubTimer));

    try {
        parentPort?.postMessage({ name: 'view_listen', username, port, anarchy, pilot: wantPilot });
    } catch { /* parent gone */ }

    return {
        ...attach,
        pilot,
        recorder,
    };
}
