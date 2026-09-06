/**
 * Auth/proxy faults — стоп рестартов и показ на /fleet.
 */

export const AUTH_FAULT_BAD_PASSWORD = 'bad_password';
export const AUTH_FAULT_PROXY = 'proxy_error';

/** FunTime: неверный пароль в чате или в kick reason (в т.ч. NBT JSON). */
export function isWrongPasswordText(raw) {
    const s = String(raw || '').toLowerCase();
    if (!s) return false;
    return (
        s.includes('неправильный пароль')
        || s.includes('неверный пароль')
        || s.includes('wrong password')
        || s.includes('incorrect password')
    );
}

export function authFaultLabel(kind) {
    if (kind === AUTH_FAULT_BAD_PASSWORD) return 'неверный пароль';
    if (kind === AUTH_FAULT_PROXY) return 'ошибка прокси';
    return kind || 'ошибка';
}
