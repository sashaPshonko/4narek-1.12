/**
 * FunTime staff SS-check (AnyDesk/RustDesk) — рвём сокет, рестарт через 10м.
 */

export const STAFF_CHECK_EVACUATE_MS = 10 * 60 * 1000;

/** Exit-код воркера → оркестратор ждёт STAFF_CHECK_EVACUATE_MS перед рестартом. */
export const EXIT_STAFF_CHECK = 73;

/** Сообщение «вызваны на проверку читов» / AnyDesk+RustDesk. */
export function isStaffCheckText(raw) {
    const s = String(raw || '');
    if (!s) return false;
    const lower = s.toLowerCase();
    if (lower.includes('вызваны на проверку читов')) return true;
    if (lower.includes('проверку читов') && lower.includes('признание')) return true;
    if (lower.includes('проверка выполняется через') && lower.includes('anydesk')) return true;
    if (lower.includes('anydesk') && lower.includes('rustdesk')) return true;
    return false;
}
