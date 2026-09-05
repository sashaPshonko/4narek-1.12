/**
 * Задержка клика на АХ: (step) × номер строки + per-bot jitter.
 * Строка 1 = слоты 0–8, строка 2 = слоты 9–17.
 * Reload всегда слот 50.
 */

import { createAhTempoProfile } from './bot-tempo.mjs';

function delayMs(range) {
    if (typeof range === 'number') return range;
    return Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
}

const AH_BUY_STEP_DEFAULT = { min: 1000, max: 1500 };
const SLOTS_PER_ROW = 9;

/** @type {ReturnType<typeof createAhTempoProfile> | null} */
let ahProfile = null;

export function initAhTempo(username) {
    ahProfile = createAhTempoProfile(username);
}

export const AH_SLOT_RELOAD_MAIN = 50;

/** Номер строки аукциона: 1 для 0–8, 2 для 9–17. */
export function ahRowNumber(slot) {
    return Math.floor(Number(slot) / SLOTS_PER_ROW) + 1;
}

/** step × номер строки + джиттер профиля бота */
export function ahBuyDelayMs(slot) {
    const row = ahRowNumber(slot);
    const step = ahProfile?.buyStep ?? AH_BUY_STEP_DEFAULT;
    return delayMs(step) * row + (ahProfile?.extraJitter() ?? 0);
}

export function ahBuyScanBaseMs(slot) {
    return ahBuyDelayMs(slot);
}

export function ahGlassDelayMs() {
    if (ahProfile?.glass) return delayMs(ahProfile.glass);
    return delayMs({ min: 400, max: 1000 });
}

/** Клик по лоту с ценой как у фейк-слота (≤150k). */
export function ahFakeSlotBuyDelayMs() {
    const base = delayMs({ min: 5000, max: 10000 });
    return base + (ahProfile?.extraJitter() ?? 0);
}

export function pickAhReloadSlot() {
    return AH_SLOT_RELOAD_MAIN;
}

export function pickAhBrowseAction() {
    return { type: 'reload', slot: AH_SLOT_RELOAD_MAIN };
}

/** @deprecated всегда false — берём первый выгодный */
export function shouldSkipLotEntirely() {
    return false;
}

/** @deprecated всегда 0 — первый выгодный слева */
export function pickProfitableCandidateIndex(_count) {
    return 0;
}
