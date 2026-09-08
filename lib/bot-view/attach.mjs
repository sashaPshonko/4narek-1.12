import { createRequire } from 'module';
import mc from 'minecraft-protocol';
import { packetId } from './wire.mjs';

const require = createRequire(import.meta.url);

function writeSafe(client, name, data) {
    try {
        client.write(name, data);
        return true;
    } catch (err) {
        return err;
    }
}

function chatFromClientPacket(name, data) {
    if (!data) return null;
    if (name === 'chat' || name === 'chat_message') {
        const msg = data.message ?? data.messageText ?? '';
        return String(msg || '').trim() || null;
    }
    if (name === 'chat_command' || name === 'chat_command_signed') {
        const cmd = data.command ?? data.commandUnsigned ?? '';
        const s = String(cmd || '').trim();
        if (!s) return null;
        return s.startsWith('/') ? s : `/${s}`;
    }
    return null;
}

function waitPacket(client, name, ms) {
    return new Promise((resolve) => {
        const t = setTimeout(() => {
            client.removeListener(name, onPkt);
            resolve(false);
        }, ms);
        const onPkt = () => {
            clearTimeout(t);
            client.removeListener(name, onPkt);
            resolve(true);
        };
        client.once(name, onPkt);
    });
}

function writePacket(client, pkt, log) {
    if (pkt?.raw) {
        try {
            client.writeRaw(pkt.raw);
            return true;
        } catch (err) {
            log(`raw ${pkt.name}: ${err?.message || err}`);
        }
    }
    if (pkt?.name) return writeSafe(client, pkt.name, pkt.data ?? {});
    return false;
}

function loginDebug(pkt) {
    const d = pkt?.data;
    if (!d) return pkt?.raw ? `raw ${pkt.raw.length}b id=${pkt.raw[0]}` : 'нет';
    const w = d.worldState || {};
    const hex = pkt.raw ? pkt.raw.subarray(0, 12).toString('hex') : '';
    return `entity=${d.entityId} dim=${w.dimension} world=${w.name} sea=${w.seaLevel} raw=${pkt.raw?.length ?? 0}b ${hex}`;
}

function startKeepAlive(client) {
    let n = 1n;
    const t = setInterval(() => {
        if (client.ended) {
            clearInterval(t);
            return;
        }
        try {
            if (client.state !== 'play') return;
            client.write('keep_alive', { keepAliveId: n });
            n += 1n;
        } catch {
            clearInterval(t);
        }
    }, 10000);
    client.on('end', () => clearInterval(t));
    client.on('error', () => clearInterval(t));
}

function patchClient(client, onLoginAck) {
    const origWrite = client.write.bind(client);
    client.write = (name, params) => {
        if (name === 'server_data' && client.state !== 'play') return;
        return origWrite(name, params);
    };

    const origOnce = client.once.bind(client);
    origOnce('login_acknowledged', onLoginAck);
    client.once = (event, cb) => {
        if (event === 'login_acknowledged') return client;
        return origOnce(event, cb);
    };
}

async function runConfiguration(client, cache, mcData, log) {
    client.state = mc.states.CONFIGURATION;

    const replay = cache?.configPackets ?? [];
    if (replay.length > 0) {
        const names = replay.map((p) => p.name);
        log(`configuration replay: ${names.join(', ')}`);
        for (const pkt of replay) {
            if (pkt.name === 'select_known_packs') {
                const packsP = waitPacket(client, 'select_known_packs', 5000);
                writePacket(client, pkt, log);
                const gotPacks = await packsP;
                log(`known packs ack=${gotPacks}`);
                continue;
            }
            if (pkt.name === 'code_of_conduct') {
                const accP = waitPacket(client, 'accept_code_of_conduct', 8000);
                writePacket(client, pkt, log);
                log(`code_of_conduct ack=${await accP}`);
                continue;
            }
            const err = writePacket(client, pkt, log);
            if (err !== true) log(`${pkt.name}: ${err?.message || err}`);
        }
    } else {
        writeSafe(client, 'feature_flags', { features: ['minecraft:vanilla'] });

        const packsP = waitPacket(client, 'select_known_packs', 5000);
        writeSafe(client, 'select_known_packs', {
            packs: [{ namespace: 'minecraft', id: 'core', version: mcData.version.minecraftVersion }],
        });
        const gotPacks = await packsP;
        log(`known packs ack=${gotPacks} (fallback, FunTime config ещё нет)`);

        const codec = mcData.loginPacket?.dimensionCodec || mcData.registryCodec || {};
        let n = 0;
        for (const key of Object.keys(codec)) {
            const entry = codec[key];
            if (!entry?.id || !Array.isArray(entry.entries)) continue;
            const stripped = {
                id: entry.id,
                entries: entry.entries.map((e) => ({ key: e.key })),
            };
            const err = writeSafe(client, 'registry_data', stripped);
            if (err !== true) log(`registry ${key}: ${err.message || err}`);
            else n += 1;
        }
        log(`registry_data ${n} шт. (только ключи)`);
    }

    const finP = waitPacket(client, 'finish_configuration', 8000);
    writeSafe(client, 'finish_configuration', {});
    const gotFin = await finP;
    log(`finish_configuration ack=${gotFin}`);
    if (!gotFin) throw new Error('клиент не подтвердил configuration');

    client.state = mc.states.PLAY;
}

function sendWorld(client, bot, cache, log) {
    const e = bot?.entity;
    const cx = Number.isFinite(e?.position?.x) ? Math.floor(e.position.x / 16) : 0;
    const cz = Number.isFinite(e?.position?.z) ? Math.floor(e.position.z / 16) : 0;

    writeSafe(client, 'game_state_change', { reason: 'level_chunks_load_start', gameMode: 0 });
    writeSafe(client, 'update_view_distance', { viewDistance: 8 });
    writeSafe(client, 'update_view_position', { chunkX: cx, chunkZ: cz });

    const all = [...(cache.chunks?.values() ?? [])];
    const chunks = all.filter((p) => p?.raw && packetId(p.raw) === 0x2c);
    const skipped = all.length - chunks.length;
    if (all[0]?.raw) {
        log(`chunk0 id=${packetId(all[0].raw)} len=${all[0].raw.length} hex=${all[0].raw.subarray(0, 8).toString('hex')}`);
    }

    writeSafe(client, 'chunk_batch_start', {});
    let n = 0;
    for (const pkt of chunks) {
        const err = writePacket(client, pkt, log);
        if (err === true) n += 1;
        else if (err) log(`chunk: ${err.message || err}`);
    }
    writeSafe(client, 'chunk_batch_finished', { batchSize: Math.max(n, 1) });
    log(`мир: ${n} чанков (пропуск ${skipped}) view=${cx},${cz}`);

    if (cache.position) {
        const err = writePacket(client, cache.position, log);
        if (err !== true) log(`position: ${err?.message || err}`);
    } else {
        const err = writeSafe(client, 'position', {
            teleportId: 1,
            x: e?.position?.x ?? 0,
            y: e?.position?.y ?? 80,
            z: e?.position?.z ?? 0,
            dx: 0,
            dy: 0,
            dz: 0,
            yaw: 0,
            pitch: 0,
            flags: { _value: 0 },
        });
        if (err !== true) log(`position: ${err.message || err}`);
    }

    const hud = cache.dumpHud?.() ?? [];
    const counts = {};
    let extra = 0;
    for (const pkt of hud) {
        counts[pkt.name] = (counts[pkt.name] || 0) + 1;
        const err = writePacket(client, pkt, log);
        if (err === true) extra += 1;
        else if (err) log(`hud ${pkt.name}: ${err.message || err}`);
    }
    log(`hud: ${extra} ${JSON.stringify(counts)}`);
}

function sendJoin(client, bot, cache, mcData, log) {
    const loginPkt = cache?.login;
    log(`FunTime login: ${loginDebug(loginPkt)}`);

    if (loginPkt) {
        const err = writePacket(client, loginPkt, log);
        if (err !== true) log(`login: ${err?.message || err}`);
        else log('login отправлен (пакет FunTime)');
    } else {
        log('нет кэша login — TLauncher скорее всего упадёт');
    }

    sendWorld(client, bot, cache, log);
}

export function startAttachServer({
    host,
    port,
    version,
    motd,
    cache,
    getBot,
    onSpectatorChat,
    log = console.log,
}) {
    const spectators = new Set();
    let writeFails = 0;
    const mcData = require('minecraft-data')(version);

    const server = mc.createServer({
        'online-mode': false,
        host,
        port,
        version,
        motd: motd || 'bot-view',
        maxPlayers: 1,
        keepAlive: false,
        enforceSecureProfile: false,
        hideErrors: false,
        errorHandler: (client, err) => {
            log(`клиент ${client.username || '?'}: ${err?.message || err}`);
            try { client.end(String(err?.message || 'error')); } catch { /* ignore */ }
        },
    });

    server.on('connection', (client) => {
        log(`handshake ${client.socket?.remoteAddress || '?'}`);
        patchClient(client, async () => {
            try {
                await runConfiguration(client, cache, mcData, log);
                server.emit('playerJoin', client);
            } catch (err) {
                log(`configuration: ${err?.message || err}`);
                try { client.end('configuration failed'); } catch { /* ignore */ }
            }
        });
    });

    server.on('playerJoin', (client) => {
        const addr = client.socket?.remoteAddress || '?';
        log(`TLauncher ${client.username} с ${addr}`);

        if (spectators.size > 0) {
            client.end('уже кто-то смотрит, выйди там и зайди снова');
            return;
        }

        const bot = getBot();
        if (!bot?._client || bot._client.state !== 'play') {
            client.end('бот ещё не в игре — подожди пару секунд и зайди снова');
            return;
        }

        client.on('end', (reason) => {
            spectators.delete(client);
            log(`TLauncher ${client.username} отключился: ${reason || ''}`);
        });
        client.on('error', (err) => {
            spectators.delete(client);
            log(`TLauncher error: ${err?.message || err}`);
        });
        client.on('packet', (data, meta) => {
            if (meta?.state !== 'play') return;
            const chat = chatFromClientPacket(meta.name, data);
            if (chat) {
                onSpectatorChat?.(chat, client.username);
            }
        });

        sendJoin(client, bot, cache, mcData, log);
        startKeepAlive(client);
        spectators.add(client);
        log(`вход ок`);
    });

    let worldChangeWait = null;

    async function beginWorldChange() {
        const list = [...spectators].filter((c) => !c.ended && c.state === 'play');
        if (list.length === 0) return;
        log('FunTime смена мира — прокидываю configuration в TLauncher');
        worldChangeWait = (async () => {
            for (const client of list) {
                client.reconfiguring = true;
                writeSafe(client, 'start_configuration', {});
                const ack = await waitPacket(client, 'configuration_acknowledged', 10000);
                if (!ack || client.ended) {
                    log('TLauncher не подтвердил start_configuration');
                    try { client.end('configuration_acknowledged timeout'); } catch { /* ignore */ }
                    spectators.delete(client);
                    continue;
                }
                client.state = mc.states.CONFIGURATION;
            }
        })();
        await worldChangeWait;
    }

    async function finishWorldChange() {
        if (worldChangeWait) {
            try { await worldChangeWait; } catch { /* ignore */ }
        }
        const bot = getBot();
        const list = [...spectators].filter((c) => !c.ended && c.reconfiguring);
        if (list.length === 0) return;
        for (const client of list) {
            try {
                await runConfiguration(client, cache, mcData, log);
                const loginPkt = cache.login;
                if (loginPkt) writePacket(client, loginPkt, log);
                log('ждём чанки нового мира');
                const t0 = Date.now();
                while (cache.stats().chunks < 8 && Date.now() - t0 < 4000) {
                    await new Promise((r) => setTimeout(r, 200));
                }
                sendWorld(client, bot, cache, log);
                client.reconfiguring = false;
                log('TLauncher снова в play после смены мира');
            } catch (err) {
                log(`смена мира: ${err?.message || err}`);
                try { client.end('world change failed'); } catch { /* ignore */ }
                spectators.delete(client);
            }
        }
        worldChangeWait = null;
    }

    function forwardFromBot(buf) {
        if (!buf?.length || spectators.size === 0) return;
        for (const client of spectators) {
            if (client.ended || client.reconfiguring || client.state !== 'play') continue;
            try {
                client.writeRaw(Buffer.from(buf));
            } catch (err) {
                writeFails += 1;
                if (writeFails < 8) log(`forward: ${err?.message || err}`);
            }
        }
    }

    function kickAll(reason) {
        for (const client of [...spectators]) {
            try { client.end(reason || 'бот отключился'); } catch { /* ignore */ }
        }
        spectators.clear();
    }

    server.on('error', (err) => log(`attach server: ${err?.message || err}`));
    server.on('listening', () => {
        const addr = server.socketServer.address();
        log(`TLauncher → ${host}:${addr.port}  версия ${version}`);
    });

    return {
        server,
        spectators,
        forwardFromBot,
        kickAll,
        beginWorldChange,
        finishWorldChange,
    };
}
