/**
 * Auth/proxy faults — стоп рестартов и показ на /fleet.
 */

export const AUTH_FAULT_BAD_PASSWORD = 'bad_password';
export const AUTH_FAULT_PROXY = 'proxy_error';

/** Exit-коды воркера — надёжнее postMessage (process.exit может дропнуть IPC). */
export const EXIT_BAD_PASSWORD = 71;
export const EXIT_PROXY_ERROR = 72;

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

export function authFaultKindFromExitCode(code) {
    if (code === EXIT_BAD_PASSWORD) return AUTH_FAULT_BAD_PASSWORD;
    if (code === EXIT_PROXY_ERROR) return AUTH_FAULT_PROXY;
    return null;
}

export function authFaultLabel(kind) {
    if (kind === AUTH_FAULT_BAD_PASSWORD) return 'неверный пароль';
    if (kind === AUTH_FAULT_PROXY) return 'ошибка прокси';
    return kind || 'ошибка';
}
