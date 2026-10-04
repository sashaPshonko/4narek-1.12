#!/usr/bin/env node
/**
 * Сводка wire-записи пилота (sample / out / spec).
 *
 *   node scripts/analyze-wire-record.mjs motion-records/….jsonl
 */
import fs from 'fs';

const path = process.argv[2];
if (!path) {
    console.error('usage: node scripts/analyze-wire-record.mjs <file.jsonl>');
    process.exit(2);
}

const lines = fs.readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const meta = lines.find((r) => r.kind === 'meta');
const end = lines.find((r) => r.kind === 'end');
const samples = lines.filter((r) => r.kind === 'sample');
const outs = lines.filter((r) => r.kind === 'out');
const specs = lines.filter((r) => r.kind === 'spec');

function countBy(rows, key = 'name') {
    const m = new Map();
    for (const r of rows) {
        const k = r[key] || '?';
        m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** Пары подряд out-имён (окно протокола). */
function transitions(rows, n = 12) {
    const seq = rows.map((r) => r.name);
    const pairs = new Map();
    for (let i = 1; i < seq.length; i++) {
        const k = `${seq[i - 1]} → ${seq[i]}`;
        pairs.set(k, (pairs.get(k) || 0) + 1);
    }
    return [...pairs.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function inputChanges(outs) {
    const inputs = outs.filter((r) => r.name === 'player_input');
    let changes = 0;
    let prev = '';
    for (const r of inputs) {
        const s = JSON.stringify(r.data?.inputs || r.data);
        if (s !== prev) {
            changes += 1;
            prev = s;
        }
    }
    return { packets: inputs.length, uniqueStates: changes };
}

const moveOuts = outs.filter((r) => ['position', 'look', 'position_look', 'flying'].includes(r.name));
const dt = [];
for (let i = 1; i < Math.min(moveOuts.length, 500); i++) {
    dt.push(moveOuts[i].t_ms - moveOuts[i - 1].t_ms);
}
dt.sort((a, b) => a - b);
const med = dt.length ? dt[Math.floor(dt.length / 2)] : null;

console.log(JSON.stringify({
    file: path.split('/').pop(),
    meta: meta && { v: meta.v, wire: meta.wire, tag: meta.tag, startedAt: meta.startedAt },
    end,
    counts: {
        samples: samples.length,
        outs: outs.length,
        specs: specs.length,
        outByName: Object.fromEntries(countBy(outs)),
        specByName: Object.fromEntries(countBy(specs)),
    },
    player_input: inputChanges(outs),
    moveDt_ms_p50: med,
    topOutTransitions: Object.fromEntries(transitions(outs)),
    firstOutSeq: outs.slice(0, 20).map((r) => r.name),
    firstSpecSeq: specs.slice(0, 15).map((r) => r.name),
}, null, 2));
