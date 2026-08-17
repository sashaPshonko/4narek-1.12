/**
 * Задержка клика на АХ: (500–1000 мс) × номер строки.
 * Строка 1 = слоты 0–8, строка 2 = слоты 9–17.
 * Reload всегда слот 50. Без скипов и залипов.
 */

function delayMs(range) {
    if (typeof range === 'number') return range;
    return Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
}

const AH_BUY_STEP = { min: 500, max: 1000 };
const SLOTS_PER_ROW = 9;

export const AH_SLOT_RELOAD_MAIN = 50;

/** Номер строки аукциона: 1 для 0–8, 2 для 9–17. */
export function ahRowNumber(slot) {
    return Math.floor(Number(slot) / SLOTS_PER_ROW) + 1;
}

/** (500–1000 мс) × номер строки */
export function ahBuyDelayMs(slot) {
    const row = ahRowNumber(slot);
    return delayMs(AH_BUY_STEP) * row;
}

export function ahBuyScanBaseMs(slot) {
    return ahBuyDelayMs(slot);
}

export function ahGlassDelayMs() {
    return delayMs({ min: 400, max: 1000 });
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
