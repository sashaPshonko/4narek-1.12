import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TIMING = JSON.parse(readFileSync(join(__dirname, 'delay.json'), 'utf8'));

export function getDelayMs(key) {
    const range = TIMING[key];
    if (range == null) throw new Error(`Нет задержки: ${key}`);
    return typeof range === 'number'
        ? range
        : Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
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
