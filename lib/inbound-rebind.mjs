/**
 * FunTime шлёт ванильные байты; TLauncher (jar 1.21.11) их ест.
 * Частый корень падений: minecraft-data@3.116 кривой attribute_modifiers
 * (display на весь компонент вместо per-entry как ItemAttributeModifiers$Entry)
 * → protodef съезжает → «array size is abnormally large» на anonymousNbt.
 * Фикс схемы: scripts/apply-vanilla-engine-patches.mjs.
 * Soft-skip — страховка на остальные дыры Slot. Только ITEM-пакеты.
 * Chunk/login/chat/keep_alive/open_window — никогда не скип; при фейле → end.
 */

import { tapClientPackets } from './bot-view/wire.mjs';

/** play.toClient ids (1.21.11) с Slot внутри — можно дропнуть один апдейт. */
const SOFT_SKIP_PACKET_IDS = new Set([
    0x12, // window_items
    0x14, // set_slot
    0x5e, // set_cursor_item
    0x61, // entity_metadata (иногда item)
    0x64, // entity_equipment
]);

const SOFT_MSG = [
    'array size is abnormally large',
    'Invalid tag',
    'Read error for undefined',
    'beyond the bounds of the managed data',
    'Compressed data is corrupt',
    'unexpected end of buffer',
];

export function isDeserializerKillError(err) {
    if (!err) return false;
    if (err.partialReadError || err.funtimeSkipped) return false;
    const msg = String(err.message ?? err);
    return SOFT_MSG.some((s) => msg.includes(s)) || msg.includes('Parse error for');
}

function isSoftSchemaFailure(err) {
    if (!err) return false;
    if (err.partialReadError) return true;
    const msg = String(err.message ?? err);
    return SOFT_MSG.some((s) => msg.includes(s));
}

function readPacketId(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 1) return null;
    let value = 0;
    let shift = 0;
    for (let i = 0; i < Math.min(buf.length, 5); i++) {
        const b = buf[i];
        value |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) return value >>> 0;
        shift += 7;
    }
    return null;
}

export function patchDeserializerSkipBadPackets(deserializer, log) {
    if (!deserializer || typeof deserializer.parsePacketBuffer !== 'function') return false;
    if (deserializer._funtimeSkipBad) return true;
    deserializer._funtimeSkipBad = true;
    const orig = deserializer.parsePacketBuffer.bind(deserializer);
    deserializer.parsePacketBuffer = (buffer) => {
        try {
            return orig(buffer);
        } catch (e) {
            if (!isSoftSchemaFailure(e)) throw e;
            const id = readPacketId(buffer);
            // Только item-bearing: иначе сожрём map_chunk и получим physics stall.
            if (id != null && SOFT_SKIP_PACKET_IDS.has(id)) {
                e.partialReadError = true;
                e.funtimeSkipped = true;
                const now = Date.now();
                if (!deserializer._ftSoftNoiseAt || now - deserializer._ftSoftNoiseAt > 10_000) {
                    deserializer._ftSoftNoiseAt = now;
                    const msg = `protocol → Slot/schema miss id=0x${id.toString(16)} (TLauncher ok, nmp SlotComponent нет) — пакет слота пропущен`;
                    try { log?.(msg); } catch { /* ignore */ }
                    try { console.warn(`[protocol] ⚡ ${msg}`); } catch { /* ignore */ }
                }
                throw e;
            }
            // Критичный пакет (chunk/login/chat/window) — не маскируем
            throw e;
        }
    };
    return true;
}

/** @deprecated mid-stream rebind запрещён */
export function rebindInboundDeserializer() {
    return false;
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{ log?: (msg: string) => void, desyncMs?: number }} [opts]
 */
export function installInboundRebind(bot, opts = {}) {
    const client = bot?._client;
    if (!client || client._inboundRebindInstalled) return;
    client._inboundRebindInstalled = true;

    const log = typeof opts.log === 'function' ? opts.log : null;
    const desyncMs = Number(opts.desyncMs) > 0 ? Number(opts.desyncMs) : 25_000;

    let lastWireAt = 0;
    let lastParsedAt = 0;
    let endedForDesync = false;

    const note = (msg) => {
        try { log?.(msg); } catch { /* ignore */ }
        try { console.warn(`[${bot.username || 'bot'}] ⚡ ${msg}`); } catch { /* ignore */ }
    };

    const patchCurrent = () => {
        patchDeserializerSkipBadPackets(client.deserializer, (m) => note(m));
    };
    patchCurrent();

    // После каждого setSerializer (state change) — новый deserializer
    if (!client._ftSetSerializerPatched) {
        client._ftSetSerializerPatched = true;
        const origSetSerializer = client.setSerializer.bind(client);
        client.setSerializer = (state) => {
            origSetSerializer(state);
            patchCurrent();
        };
    }
    client.on('state', () => setImmediate(patchCurrent));

    client._rebindInbound = (why = 'manual') => {
        if (endedForDesync || client.ended) return false;
        endedForDesync = true;
        note(`inbound → reconnect (${why})`);
        try { client.end('inboundDesync'); } catch { /* ignore */ }
        return true;
    };

    tapClientPackets(client, () => {
        lastWireAt = Date.now();
    });
    client.on('packet', () => {
        lastParsedAt = Date.now();
    });

    const onErr = (err) => {
        if (err?.funtimeSkipped || err?.partialReadError) return;
        if (!isDeserializerKillError(err)) return;
        // Не item-soft → парсер мог умереть на chunk. Чистый reconnect.
        note(`inbound → schema/parse kill: ${String(err.message || err).slice(0, 70)}`);
    };
    client.on('error', onErr);
    bot.on?.('error', onErr);

    const watchdog = setInterval(() => {
        if (client.ended || endedForDesync) return;
        if (client.state !== 'play') return;
        patchCurrent();
        const now = Date.now();
        if (!lastWireAt || now - lastWireAt > desyncMs) return;
        if (lastParsedAt && now - lastParsedAt < desyncMs) return;
        endedForDesync = true;
        note(`inbound → wire≠packet ${Math.round((now - (lastParsedAt || 0)) / 1000)}с — reconnect`);
        try { client.end('inboundDesync'); } catch { /* ignore */ }
    }, 4000);
    watchdog.unref?.();

    const stop = () => clearInterval(watchdog);
    client.on('end', stop);
    bot.once?.('end', stop);
}

export function hasChunkUnderFeet(bot) {
    try {
        if (!bot?.entity?.position) return false;
        return bot.blockAt(bot.entity.position) != null;
    } catch {
        return false;
    }
}

export async function waitChunkUnderFeet(bot, maxMs = 20_000, shouldAbort = null) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        if (typeof shouldAbort === 'function' && shouldAbort()) return false;
        if (hasChunkUnderFeet(bot)) return true;
        await new Promise((r) => setTimeout(r, 200));
    }
    return hasChunkUnderFeet(bot);
}
