/**
 * Захват капчи → POST solver → цифры → /reg → /l
 * Всё лежит в 4narek-1.12/lib/captcha (без соседнего kapcha/).
 */
import { waitForCaptcha, attachMapCache } from './capture.mjs';

export const CAPTCHA_CHAT_MARKER = 'BotFilter >> Введите номер с картинки в чат';

export function isCaptchaChat(text) {
    const s = String(text || '').toLowerCase();
    return (
        s.includes('введите номер с картинки') ||
        s.includes(CAPTCHA_CHAT_MARKER.toLowerCase())
    );
}

/**
 * @param {string} solverUrl
 * @param {{ pngBase64: string, username?: string, fingerprint?: string, timeoutMs?: number }} opts
 */
export async function solveRemote(solverUrl, opts) {
    const base = String(solverUrl || '').replace(/\/$/, '');
    if (!base) throw new Error('solverUrl empty');
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20_000);
    try {
        const res = await fetch(`${base}/api/solve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pngBase64: opts.pngBase64,
                username: opts.username || undefined,
                fingerprint: opts.fingerprint || undefined,
            }),
            signal: ctrl.signal,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new Error(`solve HTTP ${res.status}: ${body.detail || JSON.stringify(body)}`);
        }
        if (!body.ok && body.low_conf) {
            throw new Error(`low conf ${body.conf} pred=${body.pred}`);
        }
        if (!body.pred || !/^\d{5}$/.test(body.pred)) {
            throw new Error(`bad pred ${JSON.stringify(body)}`);
        }
        return body;
    } finally {
        clearTimeout(t);
    }
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{
 *   password: string,
 *   solverUrl: string,
 *   username?: string,
 *   quietMs?: number,
 *   maxWaitMs?: number,
 *   afterAnswerMs?: number,
 *   afterRegMs?: number,
 *   log?: (...a:any[]) => void,
 * }} opts
 */
export async function handleCaptchaLogin(bot, opts) {
    const log = opts.log || ((...a) => console.log('[captcha]', ...a));
    const password = String(opts.password || '');
    if (!password) throw new Error('password required');

    attachMapCache(bot);

    log('waiting for captcha maps…');
    const captured = await waitForCaptcha(bot, {
        quietMs: opts.quietMs ?? 900,
        maxWaitMs: opts.maxWaitMs ?? 20_000,
        log,
    });
    if (!captured?.png) {
        throw new Error('captcha capture failed / timeout');
    }

    const pngBase64 = Buffer.isBuffer(captured.png)
        ? captured.png.toString('base64')
        : Buffer.from(captured.png).toString('base64');

    log('solving remote…', opts.solverUrl);
    const solved = await solveRemote(opts.solverUrl, {
        pngBase64,
        username: opts.username || bot.username,
        fingerprint: captured.fingerprint,
    });
    log('pred', solved.pred, 'conf', solved.conf, `${solved.ms}ms`);

    bot.chat(solved.pred);
    await sleep(opts.afterAnswerMs ?? 800);
    bot.chat(`/reg ${password}`);
    await sleep(opts.afterRegMs ?? 600);
    bot.chat(`/l ${password}`);

    return { pred: solved.pred, conf: solved.conf, ms: solved.ms };
}

export { attachMapCache, waitForCaptcha };
