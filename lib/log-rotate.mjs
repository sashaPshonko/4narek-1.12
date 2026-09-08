import fs from 'fs';
import path from 'path';

const DEFAULT_MAX = 80 * 1024 * 1024;
const DEFAULT_KEEP_DAYS = 7;

function listRotated(file) {
    const dir = path.dirname(file);
    const base = path.basename(file);
    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter((n) => n.startsWith(`${base}.`) && /^\d{4}-\d{2}-\d{2}/.test(n.slice(base.length + 1)))
        .map((n) => path.join(dir, n));
}

/** copytruncate: работает, если процесс пишет с O_APPEND (exec >> log). */
export function rotateLogFile(file, { maxBytes = DEFAULT_MAX, keepDays = DEFAULT_KEEP_DAYS } = {}) {
    if (!file) return false;
    let st;
    try {
        st = fs.statSync(file);
    } catch {
        return false;
    }
    if (!st.isFile() || st.size < maxBytes) {
        pruneOld(file, keepDays);
        return false;
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const dest = `${file}.${stamp}`;
    try {
        fs.copyFileSync(file, dest);
        fs.truncateSync(file, 0);
    } catch (err) {
        console.error(`[log-rotate] ${file}: ${err.message}`);
        return false;
    }
    pruneOld(file, keepDays);
    console.log(`[log-rotate] ${path.basename(file)} → ${path.basename(dest)} (${Math.round(st.size / 1024 / 1024)}MB)`);
    return true;
}

function pruneOld(file, keepDays) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    for (const p of listRotated(file)) {
        try {
            const st = fs.statSync(p);
            if (st.mtimeMs < cutoff) fs.unlinkSync(p);
        } catch { /* ignore */ }
    }
}

export function startLogRotate(files, opts = {}) {
    const list = (Array.isArray(files) ? files : [files]).filter(Boolean);
    const intervalMs = opts.intervalMs ?? 30 * 60 * 1000;
    const tick = () => {
        for (const f of list) rotateLogFile(f, opts);
    };
    tick();
    const t = setInterval(tick, intervalMs);
    t.unref?.();
    return () => clearInterval(t);
}
