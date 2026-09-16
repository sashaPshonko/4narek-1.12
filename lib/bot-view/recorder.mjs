/**
 * Запись пилота: JSONL-сэмплы look/input (+ позиция бота).
 * Формат строки: {t_ms, yaw, pitch, fwd, back, left, right, jump, sneak, sprint, x, y, z, onGround}
 */
import fs from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'motion-records');

export function createMotionRecorder({
    dir = process.env.MOTION_RECORD_DIR || DEFAULT_DIR,
    log = console.log,
} = {}) {
    let stream = null;
    let filePath = null;
    let startedAt = 0;
    let samples = 0;
    let lastWriteAt = 0;

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
        lastWriteAt = 0;
        const meta = {
            v: 1,
            kind: 'meta',
            startedAt: new Date(startedAt).toISOString(),
            tag: safe,
            note: 'pilot motion; yaw/pitch radians (mineflayer); controls bool',
        };
        stream.write(`${JSON.stringify(meta)}\n`);
        log(`record → ${filePath}`);
        return filePath;
    }

    function stop() {
        if (!stream) return null;
        const path = filePath;
        const n = samples;
        try {
            stream.write(`${JSON.stringify({
                kind: 'end',
                t_ms: Date.now() - startedAt,
                samples: n,
                endedAt: new Date().toISOString(),
            })}\n`);
            stream.end();
        } catch {
            /* ignore */
        }
        stream = null;
        filePath = null;
        startedAt = 0;
        log(`record stop → ${path} (${n} samples)`);
        return { path, samples: n };
    }

    function isRecording() {
        return Boolean(stream);
    }

    function status() {
        return {
            recording: isRecording(),
            path: filePath,
            samples,
            t_ms: startedAt ? Date.now() - startedAt : 0,
        };
    }

    /**
     * @param {object} sample
     * @param {{ minIntervalMs?: number }} [opts] — дедуп по времени (default 0 = каждый вызов)
     */
    function push(sample, opts = {}) {
        if (!stream) return false;
        const minInterval = opts.minIntervalMs ?? 0;
        const now = Date.now();
        if (minInterval > 0 && now - lastWriteAt < minInterval) return false;
        lastWriteAt = now;
        const row = {
            kind: 'sample',
            t_ms: now - startedAt,
            ...sample,
        };
        try {
            stream.write(`${JSON.stringify(row)}\n`);
            samples += 1;
            return true;
        } catch {
            return false;
        }
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

    return { start, stop, push, sampleFromBot, isRecording, status };
}
