/**
 * FunTime staff SS-check (AnyDesk).
 * Вызванный бот остаётся и шлёт /anydesk; остальные на всех анках выходят.
 * Ждём session_end с GUI VPS.
 */

/** Если GUI молчит и AnyDesk так и не дали — через столько все возвращаются. */
export const STAFF_CHECK_EVACUATE_MS = 10 * 60 * 1000;

/** Потолок ожидания после выдачи AnyDesk id (пока GUI не пришлёт session_end). */
export const STAFF_CHECK_SESSION_MAX_MS = 2 * 60 * 60 * 1000;

/** Exit-код воркера, которого выгнали из-за проверки (не stay). */
export const EXIT_STAFF_CHECK = 73;

/** Старые метки в /fleet; новый поток проверку больше не банит. */
export const STAFF_CHECK_BAN_KIND = 'staff_check';
export const STAFF_CHECK_BAN_REASON = 'проверка';

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
