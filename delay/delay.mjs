import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TIMING = JSON.parse(readFileSync(join(__dirname, 'delay.json'), 'utf8'));

export async function rnd(key) {
    const range = TIMING[key];
    if (range == null) throw new Error(`Нет задержки: ${key}`);
    const ms = typeof range === 'number'
        ? range
        : Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
    await new Promise((resolve) => setTimeout(resolve, ms));
}
