/**
 * Запись пилота: JSONL сэмплы + исходящий wire бота (+ пакеты зрителя).
 *
 * kind:
 *   meta | end | sample
 *   out  — bot → FunTime (player_input / look / position* / tick_end / …)
 *   spec — TLauncher → bot-view (то, что пилот реально получил)
 */
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'motion-records');

/** Движение / input — то, что сравниваем с ванилью. */
export const WIRE_OUT_DEFAULT = new Set([
    'player_input',
    'tick_end',
    'position',
    'look',
    'position_look',
    'flying',
    'entity_action',
    'teleport_confirm',
    'accept_teleportation',
    'arm_animation',
    'held_item_slot',
    'client_command',
]);

export const WIRE_SPEC_DEFAULT = new Set([
    'player_input',
    'look',
    'position_look',
    'position',
    'flying',
    'arm_animation',
    'entity_action',
    'held_item_slot',
]);

export function jsonSafe(value, depth = 0) {
    if (value == null) return value;
    const t = typeof value;
    if (t === 'number' || t === 'boolean' || t === 'string') return value;
    if (t === 'bigint') return value.toString();
    if (Buffer.isBuffer(value)) {
        return { _buf: value.length, hex: value.subarray(0, 48).toString('hex') };
    }
    if (Array.isArray(value)) {
        if (depth > 5) return `[len ${value.length}]`;
        return value.map((v) => jsonSafe(v, depth + 1));
    }
    if (t === 'object') {
        if (depth > 5) return { _truncated: true };
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = jsonSafe(v, depth + 1);
        }
        return out;
    }
    return String(value);
}

export function createMotionRecorder({
    dir = process.env.MOTION_RECORD_DIR || DEFAULT_DIR,
    log = console.log,
    wire = null,
} = {}) {
    let stream = null;
    let filePath = null;
    let startedAt = 0;
    let samples = 0;
    let outs = 0;
    let specs = 0;
    let lastWriteAt = 0;
    let wireEnabled = wire !== false
        && process.env.VIEW_RECORD_WIRE !== '0'
        && process.env.VIEW_RECORD_WIRE !== 'off';
    const wireAll = process.env.VIEW_RECORD_WIRE === 'all';

    function ensureDir() {
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch {
            /* ignore */
        }
    }

    function start(tag = 'walk') {
        if (stream) stop();
        ensureDir();
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const safe = String(tag || 'walk').replace(/[^\w.-]+/g, '_').slice(0, 40);
        filePath = join(dir, `${stamp}_${safe}.jsonl`);
        stream = fs.createWriteStream(filePath, { flags: 'w' });
        startedAt = Date.now();
        samples = 0;
        outs = 0;
        specs = 0;
        lastWriteAt = 0;
        const meta = {
            v: 2,
            kind: 'meta',
            startedAt: new Date(startedAt).toISOString(),
            tag: safe,
            wire: wireEnabled,
            wireAll,
            note: 'sample=bot pose/controls; out=bot→FunTime; spec=TLauncher→view',
        };
        stream.write(`${JSON.stringify(meta)}\n`);
        log(`record → ${filePath} (wire=${wireEnabled ? (wireAll ? 'all' : 'move') : 'off'})`);
        return filePath;
    }

    function stop() {
        if (!stream) return null;
        const path = filePath;
        const n = samples;
        const o = outs;
        const s = specs;
        try {
            stream.write(`${JSON.stringify({
                kind: 'end',
                t_ms: Date.now() - startedAt,
                samples: n,
                outs: o,
                specs: s,
                endedAt: new Date().toISOString(),
            })}\n`);
            stream.end();
        } catch {
            /* ignore */
        }
        stream = null;
        filePath = null;
        startedAt = 0;
        log(`record stop → ${path} (samples=${n} outs=${o} specs=${s})`);
        return { path, samples: n, outs: o, specs: s };
    }

    function isRecording() {
        return Boolean(stream);
    }

    function setWireEnabled(on) {
        wireEnabled = !!on;
        return wireEnabled;
    }

    function status() {
        return {
            recording: isRecording(),
            path: filePath,
            samples,
            outs,
            specs,
            wire: wireEnabled,
            t_ms: startedAt ? Date.now() - startedAt : 0,
        };
    }

    function writeRow(row) {
        if (!stream) return false;
        try {
            stream.write(`${JSON.stringify(row)}\n`);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * @param {object} sample
     * @param {{ minIntervalMs?: number }} [opts]
     */
    function push(sample, opts = {}) {
        if (!stream) return false;
        const minInterval = opts.minIntervalMs ?? 0;
        const now = Date.now();
        if (minInterval > 0 && now - lastWriteAt < minInterval) return false;
        lastWriteAt = now;
        const ok = writeRow({
            kind: 'sample',
            t_ms: now - startedAt,
            ...sample,
        });
        if (ok) samples += 1;
        return ok;
    }

    function pushOut(name, data) {
        if (!stream || !wireEnabled || !name) return false;
        if (!wireAll && !WIRE_OUT_DEFAULT.has(name)) return false;
        const ok = writeRow({
            kind: 'out',
            t_ms: Date.now() - startedAt,
            name,
            data: jsonSafe(data),
        });
        if (ok) outs += 1;
        return ok;
    }

    function pushSpec(name, data) {
        if (!stream || !wireEnabled || !name) return false;
        if (!wireAll && !WIRE_SPEC_DEFAULT.has(name)) return false;
        const ok = writeRow({
            kind: 'spec',
            t_ms: Date.now() - startedAt,
            name,
            data: jsonSafe(data),
        });
        if (ok) specs += 1;
        return ok;
    }

    function sampleFromBot(bot, controls = {}) {
        const e = bot?.entity;
        if (!e) return false;
        return push({
            yaw: e.yaw,
            pitch: e.pitch,
            fwd: !!controls.forward,
            back: !!controls.back,
            left: !!controls.left,
            right: !!controls.right,
            jump: !!controls.jump,
            sneak: !!controls.sneak,
            sprint: !!controls.sprint,
            x: e.position?.x,
            y: e.position?.y,
            z: e.position?.z,
            onGround: !!e.onGround,
        }, { minIntervalMs: 0 });
    }

    return {
        start,
        stop,
        push,
        pushOut,
        pushSpec,
        sampleFromBot,
        isRecording,
        setWireEnabled,
        status,
    };
}
