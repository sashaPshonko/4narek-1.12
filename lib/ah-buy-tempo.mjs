/**
 * Базовый скан АХ + редкая доп. пауза + «человечная» навигация.
 *
 * Скип: (1) иногда не первый выгодный; (2) иногда не берём лот вообще
 * (даже если он один) → дальше reload.
 *
 * Reload: чаще 50, иногда промах на 49.
 */

function delayMs(range) {
    if (typeof range === 'number') return range;
    return Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
}

const AH_BUY_STEP = { min: 700, max: 1100 };

/** Редко, но люто — «залип в чат / вкладку». */
const EXTRA_DELAY_CHANCE = 0.08;
const EXTRA_DELAY = { min: 8000, max: 28000 };

/** Среди ≥2 выгодных — иногда не левый первый. */
const SKIP_FIRST_PROFITABLE_CHANCE = 0.15;

/** Даже при одном выгодном — иногда не берём (уходим в browse). */
const SKIP_LOT_ENTIRELY_CHANCE = 0.08;

/** Промах релоада: 49 вместо основного 50. */
const RELOAD_MISS_CHANCE = 0.22;

export const AH_SLOT_RELOAD_MAIN = 50;
export const AH_SLOT_RELOAD_MISS = 49;

function ahBuyScanDelayMs(slot) {
    const steps = Math.max(1, Number(slot) + 2);
    let total = 0;
    for (let i = 0; i < steps; i++) total += delayMs(AH_BUY_STEP);
    return total;
}

export function ahBuyDelayMs(slot) {
    let ms = ahBuyScanDelayMs(slot);
    if (Math.random() < EXTRA_DELAY_CHANCE) {
        ms += delayMs(EXTRA_DELAY);
    }
    return ms;
}

export function ahBuyScanBaseMs(slot) {
    return ahBuyScanDelayMs(slot);
}

export function ahGlassDelayMs() {
    return delayMs({ min: 400, max: 1000 });
}

/** Чаще 50, иногда промах на 49. */
export function pickAhReloadSlot() {
    return Math.random() < RELOAD_MISS_CHANCE
        ? AH_SLOT_RELOAD_MISS
        : AH_SLOT_RELOAD_MAIN;
}

/**
 * Когда не покупаем — только reload (слот 49/50).
 * @returns {{ type: 'reload', slot: number }}
 */
export function pickAhBrowseAction() {
    return { type: 'reload', slot: pickAhReloadSlot() };
}

/** Не брать лот(ы) в этом проходе — уйти в browse. */
export function shouldSkipLotEntirely() {
    return Math.random() < SKIP_LOT_ENTIRELY_CHANCE;
}

/**
 * Индекс среди выгодных L→R (если лот всё же берём).
 * @param {number} count
 */
export function pickProfitableCandidateIndex(count) {
    const n = Math.max(0, Number(count) | 0);
    if (n <= 1) return 0;
    if (Math.random() >= SKIP_FIRST_PROFITABLE_CHANCE) return 0;
    if (n === 2 || Math.random() < 0.7) return 1;
    return 1 + Math.floor(Math.random() * (n - 1));
}
