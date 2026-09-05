import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { hashUsername } from '../lib/bot-tempo.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TIMING = JSON.parse(readFileSync(join(__dirname, 'delay.json'), 'utf8'));

/** Per-worker: разные scale/jitter, чтобы боты не ходили в одном ритме. */
let delayScale = 1;
let delayJitterMax = 0;

export function initBotDelayProfile(username) {
    const h = hashUsername(username);
    delayScale = 0.82 + (h % 45) / 100; // 0.82–1.26
    delayJitterMax = 80 + ((h >> 4) % 320); // 80–399 мс сверху
}

export function getDelayMs(key) {
    const range = TIMING[key];
    if (range == null) throw new Error(`Нет задержки: ${key}`);
    const base = typeof range === 'number'
        ? range
        : Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
    const jitter = delayJitterMax > 0
        ? Math.floor(Math.random() * (delayJitterMax + 1))
        : 0;
    return Math.max(0, Math.round(base * delayScale) + jitter);
}

export async function rnd(key) {
    await new Promise((resolve) => setTimeout(resolve, getDelayMs(key)));
}

/** Как rnd, но прерывается если shouldAbort() true; возвращает false при прерывании. */
export async function rndPoll(key, intervalMs, shouldAbort) {
    let remaining = getDelayMs(key);
    const step = Math.max(50, intervalMs ?? 100);
    while (remaining > 0) {
        if (shouldAbort?.()) return false;
        const chunk = Math.min(remaining, step);
        await new Promise((resolve) => setTimeout(resolve, chunk));
        remaining -= chunk;
    }
    return !shouldAbort?.();
}
