import { clonePacket } from './clone.mjs';
import { packetId, readVarInt, afterPacketId, spawnEntityType, WIRE_IDS } from './wire.mjs';

const SKIP_CACHE = new Set([
    'keep_alive',
    'ping',
    'pong',
    'kick_disconnect',
    'disconnect',
    'cookie_request',
    'cookie_response',
]);

const CONFIG_KEEP = new Set([
    'feature_flags',
    'select_known_packs',
    'registry_data',
    'tags',
    'reset_chat',
    'custom_payload',
    'server_links',
    'custom_report_details',
    'code_of_conduct',
]);

const CHUNK_NAMES = new Set([
    'map_chunk',
    'map_chunk_with_light',
    'level_chunk',
    'level_chunk_with_light',
]);

const POSITION_NAMES = new Set([
    'position',
    'synchronize_player_position',
]);

const LOGIN_NAMES = new Set(['login', 'login_play']);

const ENTITY_SPAWN_NAMES = new Set([
    'spawn_entity',
    'spawn_entity_living',
    'spawn_entity_experience_orb',
    'named_entity_spawn',
    'spawn_player',
]);

const SINGLETON_NAMES = new Set([
    'abilities',
    'player_abilities',
    'difficulty',
    'held_item_slot',
    'set_held_item',
    'update_health',
    'experience',
    'update_time',
    'spawn_position',
    'update_view_position',
    'update_view_distance',
    'declare_commands',
    'commands',
    'tags',
    'declare_recipes',
    'recipe',
    'unlock_recipes',
    'server_data',
    'initialize_world_border',
    'world_border',
    'game_state_change',
    'game_event',
    'set_slot',
    'window_items',
    'set_container_content',
    'set_container_slot',
    'chunk_batch_start',
    'chunk_batch_finished',
    'set_ticking_state',
    'step_tick',
    'feature_flags',
    'player_list_header',
    'system_chat',
]);

function entityIdOf(data) {
    if (data == null) return null;
    if (typeof data.entityId === 'number') return data.entityId;
    if (typeof data.entityId === 'bigint') return Number(data.entityId);
    return null;
}

export function createPacketCache() {
    const state = {
        login: null,
        respawn: null,
        position: null,
        configPackets: [],
        joinConfig: [],
        singletons: new Map(),
        chunks: new Map(),
        maps: new Map(),
        entities: new Map(),
        entityMeta: new Map(),
        playerInfo: [],
        tabAdds: [],
        bossBars: new Map(),
        chats: [],
        teams: [],
        scoreboard: [],
        entityEquip: new Map(),
        seen: new Set(),
    };

    function resetWorld() {
        state.chunks.clear();
        state.maps.clear();
        state.entities.clear();
        state.entityMeta.clear();
        state.entityEquip.clear();
        state.playerInfo = [];
        state.tabAdds = [];
        state.bossBars.clear();
        state.chats = [];
        state.teams = [];
        state.scoreboard = [];
    }

    function pruneChunks(cx, cz) {
        if (state.chunks.size <= 96) return;
        for (const [key, ch] of state.chunks) {
            if (Math.max(Math.abs(ch.x - cx), Math.abs(ch.z - cz)) > 10) {
                state.chunks.delete(key);
            }
        }
        // всё ещё много (бот телепортнулся) — срезать до 96 по порядку вставки
        while (state.chunks.size > 96) {
            const oldest = state.chunks.keys().next().value;
            if (oldest == null) break;
            state.chunks.delete(oldest);
        }
    }

    /** Энтити/карты без жёсткого капа раздувают isolate до resourceLimits (200–400MB). */
    function pruneMap(map, max) {
        while (map.size > max) {
            const oldest = map.keys().next().value;
            if (oldest == null) break;
            map.delete(oldest);
        }
    }

    function pruneEntities(max = 96) {
        while (state.entities.size > max) {
            const oldest = state.entities.keys().next().value;
            if (oldest == null) break;
            state.entities.delete(oldest);
            state.entityMeta.delete(oldest);
            state.entityEquip.delete(oldest);
        }
    }

    function copyRaw(buffer) {
        if (buffer == null) return null;
        if (Buffer.isBuffer(buffer)) return Buffer.from(buffer);
        if (buffer instanceof Uint8Array) return Buffer.from(buffer);
        return null;
    }

    function onPacket(data, meta, buffer, fullBuffer) {
        if (!meta || (meta.state !== 'play' && meta.state !== 'configuration')) return;
        const name = meta.name;
        if (!name || SKIP_CACHE.has(name)) return;
        state.seen.add(`${meta.state}:${name}`);
        const raw = copyRaw(fullBuffer) || copyRaw(buffer);

        if (meta.state === 'play' && name === 'start_configuration') {
            state.configPackets = [];
            return;
        }

        if (meta.state === 'configuration') {
            if (CONFIG_KEEP.has(name)) {
                state.configPackets.push({ name, data: clonePacket(data), raw });
            }
            return;
        }

        if (LOGIN_NAMES.has(name)) {
            state.login = { name, data: clonePacket(data), raw };
            state.joinConfig = state.configPackets.slice();
            resetWorld();
            return;
        }
        if (name === 'respawn') {
            state.respawn = { name, data: clonePacket(data), raw };
            resetWorld();
            return;
        }
        if (POSITION_NAMES.has(name)) {
            state.position = { name, data: clonePacket(data), raw };
            return;
        }
        if (CHUNK_NAMES.has(name) && data && data.x != null && data.z != null) {
            // raw достаточно для реплея зрителю; clonePacket(chunk) = мегабайты NBT на каждый чанк
            state.chunks.set(`${data.x},${data.z}`, { name, raw, x: data.x, z: data.z });
            pruneChunks(data.x, data.z);
            return;
        }
        if (name === 'map' && data && data.itemDamage != null) {
            state.maps.set(data.itemDamage, { name, raw });
            pruneMap(state.maps, 48);
            return;
        }
        if (name === 'map' && data && data.mapId != null) {
            state.maps.set(data.mapId, { name, raw });
            pruneMap(state.maps, 48);
            return;
        }
        if (name === 'player_info' || name === 'player_info_update' || name === 'player_info_remove') {
            return;
        }
        if (ENTITY_SPAWN_NAMES.has(name)) {
            const id = entityIdOf(data);
            if (id != null) {
                state.entities.set(Number(id), { name, raw });
                pruneEntities(96);
            }
            return;
        }
        if (name === 'entity_metadata' || name === 'set_entity_metadata') {
            const id = entityIdOf(data);
            if (id != null && state.entities.has(Number(id))) {
                state.entityMeta.set(Number(id), { name, raw });
            }
            return;
        }
        if (name === 'entity_destroy' || name === 'destroy_entity' || name === 'remove_entities') {
            const ids = data?.entityIds ?? data?.entityId ?? [];
            const list = Array.isArray(ids) ? ids : [ids];
            for (const id of list) {
                const n = Number(id);
                state.entities.delete(n);
                state.entityMeta.delete(n);
                state.entityEquip.delete(n);
            }
            return;
        }
        if (SINGLETON_NAMES.has(name)) {
            state.singletons.set(name, { name, data: clonePacket(data), raw });
        }
    }

    function pushCap(arr, item, cap) {
        arr.push(item);
        if (arr.length > cap) arr.splice(0, arr.length - cap);
    }

    function entityIdFromRaw(buf) {
        const hdr = afterPacketId(buf);
        if (!hdr) return null;
        const eid = readVarInt(buf, hdr.size);
        return eid ? eid.value : null;
    }

    function onWire(stateName, buf) {
        if (stateName !== 'play' || !buf?.length) return;
        const id = packetId(buf);
        if (id == null) return;
        const raw = copyRaw(buf);
        if (!raw) return;
        const I = WIRE_IDS;

        if (id === I.PLAY_UNLOAD) {
            const hdr = afterPacketId(buf);
            if (!hdr || buf.length < hdr.size + 8) return;
            const x = buf.readInt32BE(hdr.size);
            const z = buf.readInt32BE(hdr.size + 4);
            state.chunks.delete(`${x},${z}`);
            return;
        }
        if (id === I.PLAY_MAP_CHUNK) {
            const hdr = afterPacketId(buf);
            if (!hdr || buf.length < hdr.size + 8) return;
            const x = buf.readInt32BE(hdr.size);
            const z = buf.readInt32BE(hdr.size + 4);
            const prev = state.chunks.get(`${x},${z}`);
            state.chunks.set(`${x},${z}`, { name: 'map_chunk', raw, x, z, data: prev?.data });
            pruneChunks(x, z);
            return;
        }
        if (id === I.PLAY_CHUNK_BATCH_START) {
            state.singletons.set('chunk_batch_start', { name: 'chunk_batch_start', raw });
            return;
        }
        if (id === I.PLAY_CHUNK_BATCH_FINISHED) {
            state.singletons.set('chunk_batch_finished', { name: 'chunk_batch_finished', raw });
            return;
        }
        if (id === I.PLAY_POSITION) {
            state.position = { name: 'position', raw, data: state.position?.data };
            return;
        }
        if (id === I.PLAY_GAME_STATE) {
            state.singletons.set('game_state_change', { name: 'game_state_change', raw });
            return;
        }
        if (id === I.PLAY_ABILITIES) {
            state.singletons.set('abilities', { name: 'abilities', raw });
            return;
        }
        if (id === I.PLAY_DIFFICULTY) {
            state.singletons.set('difficulty', { name: 'difficulty', raw });
            return;
        }
        if (id === I.PLAY_HELD) {
            state.singletons.set('held_item_slot', { name: 'held_item_slot', raw });
            return;
        }
        if (id === I.PLAY_HEALTH) {
            state.singletons.set('update_health', { name: 'update_health', raw });
            return;
        }
        if (id === I.PLAY_XP) {
            state.singletons.set('experience', { name: 'experience', raw });
            return;
        }
        if (id === I.PLAY_TIME) {
            state.singletons.set('update_time', { name: 'update_time', raw });
            return;
        }
        if (id === I.PLAY_SPAWN_POS) {
            state.singletons.set('spawn_position', { name: 'spawn_position', raw });
            return;
        }
        if (id === I.PLAY_TAB_HEADER) {
            state.singletons.set('playerlist_header', { name: 'playerlist_header', raw });
            return;
        }
        if (id === I.PLAY_SERVER_DATA) {
            state.singletons.set('server_data', { name: 'server_data', raw });
            return;
        }
        if (id === I.PLAY_BORDER) {
            state.singletons.set('initialize_world_border', { name: 'initialize_world_border', raw });
            return;
        }
        if (id === I.PLAY_BOSS_BAR) {
            const hdr = afterPacketId(buf);
            if (!hdr || buf.length < hdr.size + 17) return;
            const uuid = buf.subarray(hdr.size, hdr.size + 16).toString('hex');
            const act = readVarInt(buf, hdr.size + 16);
            if (!act) return;
            if (act.value === 1) state.bossBars.delete(uuid);
            else if (act.value === 0) state.bossBars.set(uuid, { name: 'boss_bar', raw });
            return;
        }
        if (id === I.PLAY_PLAYER_INFO) {
            const hdr = afterPacketId(buf);
            if (hdr && hdr.size < buf.length && (buf[hdr.size] & 1)) {
                pushCap(state.tabAdds, { name: 'player_info', raw }, 48);
            }
            return;
        }
        if (id === I.PLAY_PLAYER_REMOVE) {
            return;
        }
        if (id === I.PLAY_TEAMS) {
            pushCap(state.teams, { name: 'teams', raw }, 80);
            return;
        }
        if (
            id === I.PLAY_SCORE_OBJECTIVE
            || id === I.PLAY_SCORE_SCORE
            || id === I.PLAY_SCORE_DISPLAY
            || id === I.PLAY_RESET_SCORE
        ) {
            const name = id === I.PLAY_SCORE_OBJECTIVE ? 'scoreboard_objective'
                : id === I.PLAY_SCORE_SCORE ? 'scoreboard_score'
                    : id === I.PLAY_SCORE_DISPLAY ? 'scoreboard_display_objective'
                        : 'reset_score';
            pushCap(state.scoreboard, { name, raw }, 80);
            return;
        }
        if (
            id === I.PLAY_SYSTEM_CHAT
            || id === I.PLAY_PLAYER_CHAT
            || id === I.PLAY_PROFILELESS_CHAT
            || id === I.PLAY_ACTION_BAR
        ) {
            const name = id === I.PLAY_SYSTEM_CHAT ? 'system_chat'
                : id === I.PLAY_PLAYER_CHAT ? 'player_chat'
                    : id === I.PLAY_ACTION_BAR ? 'action_bar'
                        : 'profileless_chat';
            pushCap(state.chats, { name, raw }, 25);
            return;
        }
        if (id === I.PLAY_SPAWN_ENTITY) {
            if (spawnEntityType(buf) !== I.PLAYER_ENTITY_TYPE) return;
            const eid = entityIdFromRaw(buf);
            if (eid != null) {
                const prev = state.entities.get(eid);
                state.entities.set(eid, { name: 'spawn_entity', raw, data: prev?.data });
                pruneEntities(96);
            }
            return;
        }
        if (id === I.PLAY_ENTITY_META) {
            const eid = entityIdFromRaw(buf);
            if (eid != null && state.entities.has(eid)) {
                state.entityMeta.set(eid, { name: 'entity_metadata', raw });
            }
            return;
        }
        if (id === I.PLAY_ENTITY_EQUIP) {
            const eid = entityIdFromRaw(buf);
            if (eid != null && state.entities.has(eid)) {
                state.entityEquip.set(eid, { name: 'entity_equipment', raw });
            }
            return;
        }
        if (id === I.PLAY_ENTITY_DESTROY) {
            const hdr = afterPacketId(buf);
            if (!hdr) return;
            const count = readVarInt(buf, hdr.size);
            if (!count) return;
            let off = hdr.size + count.size;
            for (let i = 0; i < count.value; i += 1) {
                const eid = readVarInt(buf, off);
                if (!eid) break;
                state.entities.delete(eid.value);
                state.entityMeta.delete(eid.value);
                state.entityEquip.delete(eid.value);
                off += eid.size;
            }
            return;
        }
        if (id === I.PLAY_MAP) {
            // Раньше: maps.set(maps.size, raw) — каждый map-пакет новый ключ → heap OOM.
            // mapId приходит в onPacket; на wire без парсинга не копим.
            return;
        }
    }

    function dumpHud() {
        const out = [];
        for (const key of [
            'abilities', 'difficulty', 'held_item_slot', 'update_health', 'experience',
            'update_time', 'spawn_position',
        ]) {
            const p = state.singletons.get(key);
            if (p?.raw) out.push(p);
        }
        for (const p of state.bossBars.values()) {
            if (p?.raw) out.push(p);
        }
        for (const p of state.chats) {
            if (p?.raw) out.push(p);
        }
        const header = state.singletons.get('playerlist_header');
        if (header?.raw) out.push(header);
        for (const p of state.tabAdds) {
            if (p?.raw) out.push(p);
        }
        for (const p of state.teams) {
            if (p?.raw) out.push(p);
        }
        for (const p of state.scoreboard) {
            if (p?.raw) out.push(p);
        }
        for (const [id, spawn] of state.entities) {
            if (!spawn?.raw) continue;
            out.push(spawn);
            const meta = state.entityMeta.get(id);
            if (meta?.raw) out.push(meta);
            const eq = state.entityEquip.get(id);
            if (eq?.raw) out.push(eq);
        }
        return out;
    }

    function dumpOrder() {
        const out = [];
        if (state.login) out.push(state.login);
        if (state.respawn) out.push(state.respawn);
        for (const key of [
            'abilities', 'player_abilities', 'difficulty', 'held_item_slot', 'set_held_item',
            'game_state_change', 'game_event', 'server_data',
            'update_view_distance', 'update_view_position',
            'initialize_world_border', 'world_border',
            'declare_commands', 'commands', 'tags',
            'declare_recipes', 'recipe', 'unlock_recipes',
            'chunk_batch_start',
        ]) {
            const p = state.singletons.get(key);
            if (p) out.push(p);
        }
        for (const p of state.playerInfo) out.push(p);
        for (const p of state.chunks.values()) out.push(p);
        const batchEnd = state.singletons.get('chunk_batch_finished');
        if (batchEnd) out.push(batchEnd);
        for (const p of state.maps.values()) out.push(p);
        for (const [id, spawn] of state.entities) {
            out.push(spawn);
            const meta = state.entityMeta.get(id);
            if (meta) out.push(meta);
        }
        for (const key of [
            'window_items', 'set_container_content', 'set_slot', 'set_container_slot',
            'update_health', 'experience', 'update_time', 'spawn_position',
        ]) {
            const p = state.singletons.get(key);
            if (p) out.push(p);
        }
        if (state.position) out.push(state.position);
        return out;
    }

    function reset() {
        state.login = null;
        state.respawn = null;
        state.position = null;
        state.configPackets = [];
        state.joinConfig = [];
        state.singletons.clear();
        state.chunks.clear();
        state.maps.clear();
        state.entities.clear();
        state.entityMeta.clear();
        state.playerInfo = [];
        state.tabAdds = [];
        state.bossBars.clear();
        state.chats = [];
        state.teams = [];
        state.scoreboard = [];
        state.entityEquip.clear();
        state.seen.clear();
    }

    function isReady() {
        return Boolean(state.login);
    }

    function stats() {
        return {
            ready: isReady(),
            chunks: state.chunks.size,
            entities: state.entities.size,
            maps: state.maps.size,
            bossBars: state.bossBars.size,
            chats: state.chats.length,
            tab: state.tabAdds.length,
            teams: state.teams.length,
            scoreboard: state.scoreboard.length,
            config: state.joinConfig.length || state.configPackets.length,
            packets: dumpOrder().length,
        };
    }

    return {
        onPacket,
        onWire,
        dumpOrder,
        dumpHud,
        isReady,
        stats,
        seenNames: () => [...state.seen].sort(),
        reset,
        get login() { return state.login; },
        get position() { return state.position; },
        get configPackets() { return state.joinConfig.length ? state.joinConfig : state.configPackets; },
        get chunks() { return state.chunks; },
    };
}

export const SKIP_FORWARD = new Set([
    'keep_alive',
    'ping',
    'pong',
    'kick_disconnect',
    'disconnect',
    'cookie_request',
    'cookie_response',
    'login',
    'login_play',
    'start_configuration',
    'finish_configuration',
    'registry_data',
    'select_known_packs',
    'add_resource_pack',
    'transfer',
    'bundle_delimiter',
]);

export function shouldForwardLive(meta) {
    if (!meta || meta.state !== 'play') return false;
    if (SKIP_FORWARD.has(meta.name)) return false;
    return true;
}
