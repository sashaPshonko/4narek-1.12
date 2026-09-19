/**
 * Смены на оркестраторе: один незабаненный бот за раз.
 * 15–25 мин (рандом) → весь баланс в казну → следующий.
 * Вылет mid-shift → тот же ник на остаток времени.
 * Капча / бан / FunAuth / VPN → скип, следующий.
 */

import { awaitFleetLaunchGrant, cancelFleetLaunch } from './fleet-launch-gate.mjs';
import { EXIT_SHIFT_DONE } from './shift-exit.mjs';

const SHIFT_MIN_MS = 15 * 60 * 1000;
const SHIFT_MAX_MS = 25 * 60 * 1000;
const MIN_RESUME_MS = 2 * 60 * 1000;
const SHIFT_STOP_WAIT_MS = 55_000;
const EMPTY_QUEUE_WAIT_MS = 60_000;
const BETWEEN_SHIFTS_MS = 3_000;

function rndInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function onlyBotsFilter() {
    const raw = process.env.ONLY_BOTS || '';
    if (!raw.trim()) return null;
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

export function isShiftRotationEnabled() {
    const v = process.env.SHIFT_ROTATION;
    if (v === '0' || v === 'false' || v === 'off') return false;
    return true;
}

/** @param {string} message */
export function shiftSkipReasonFromAlert(message) {
    const lower = String(message || '').toLowerCase();
    if (lower.includes('ввести капчу') || (lower.includes('капч') && lower.includes('ввести'))) {
        return 'captcha';
    }
    if (lower.includes('vpn спалили') || lower.includes('впн спалили')) return 'vpn';
    if (lower.includes('хуйня неведомая') || lower.includes('неведомая')) return 'funauth';
    if (lower.includes('забанен')) return 'ban';
    if (lower.includes('неверный пароль') || lower.includes('ошибка прокси')) return 'auth';
    return null;
}

/**
 * @param {{
 *   bots: Map,
 *   workers: Map,
 *   pendingRestarts: Map,
 *   runWorker: (bot) => Promise,
 *   stopWorkerNoRestart: (username: string) => Promise,
 *   safePostMessage: (username: string, msg: object) => boolean,
 *   sendAlert?: (msg: string, username?: string) => Promise,
 *   isShuttingDown: () => boolean,
 *   log?: (...args: any[]) => void,
 * }} ctx
 */
export function createShiftRotator(ctx) {
    const log = ctx.log || console.log;
    let loopPromise = null;
    let stopped = false;
    /** @type {string|null} */
    let activeNick = null;
    /** @type {string|null} последний ник смены (для round-robin) */
    let lastNick = null;
    let shiftEndsAt = 0;
    /** @type {number|null} */
    let resumeRemainingMs = null;
    const skipped = new Set();
    let stopWaitResolve = null;
    let expectingShiftExit = false;

    function configuredNames() {
        const only = onlyBotsFilter();
        return [...ctx.bots.values()]
            .map((b) => b.username)
            .filter((u) => !only || only.has(u));
    }

    function eligibleBots() {
        const only = onlyBotsFilter();
        const list = [];
        for (const bot of ctx.bots.values()) {
            if (only && !only.has(bot.username)) continue;
            if (bot.banned || bot.authFault) continue;
            if (skipped.has(bot.username)) continue;
            list.push(bot);
        }
        return list;
    }

    function pickNextBot() {
        const pool = eligibleBots();
        if (!pool.length) return null;
        const names = configuredNames();
        const startIdx = lastNick ? names.indexOf(lastNick) : -1;
        for (let i = 1; i <= names.length; i++) {
            const cand = names[(startIdx + i + names.length) % names.length];
            const bot = pool.find((b) => b.username === cand);
            if (bot) return bot;
        }
        return pool[0];
    }

    function clearPendingRestart(username) {
        const t = ctx.pendingRestarts?.get(username);
        if (t) {
            clearTimeout(t);
            ctx.pendingRestarts.delete(username);
        }
    }

    async function ensureSingleWorker(nick) {
        for (const u of [...ctx.workers.keys()]) {
            if (u === nick) continue;
            log(`[shift] гашу лишнего ${u}`);
            const bot = ctx.bots.get(u);
            if (bot) bot.isManualStop = true;
            clearPendingRestart(u);
            await ctx.stopWorkerNoRestart(u);
        }
    }

    async function startNick(bot, remainingMs) {
        const username = bot.username;
        await ensureSingleWorker(username);
        clearPendingRestart(username);

        const live = ctx.workers.get(username);
        if (live?.worker && !live.worker.terminated) {
            activeNick = username;
            lastNick = username;
            const ms = remainingMs != null ? remainingMs : rndInt(SHIFT_MIN_MS, SHIFT_MAX_MS);
            shiftEndsAt = Date.now() + ms;
            resumeRemainingMs = null;
            expectingShiftExit = false;
            log(`[shift] ${username} уже live, смена ${(ms / 60000).toFixed(1)}м`);
            return true;
        }

        const ok = await awaitFleetLaunchGrant({
            username,
            anarchy: bot.anarchy,
            kind: 'bot',
            log,
        });
        if (!ok) {
            log(`[shift] launch-gate skip ${username}`);
            skipped.add(username);
            return false;
        }
        if (bot.banned || bot.authFault) {
            await cancelFleetLaunch({ username, anarchy: bot.anarchy, log });
            return false;
        }

        bot.isManualStop = false;
        activeNick = username;
        lastNick = username;
        const ms = remainingMs != null ? remainingMs : rndInt(SHIFT_MIN_MS, SHIFT_MAX_MS);
        shiftEndsAt = Date.now() + ms;
        resumeRemainingMs = null;
        expectingShiftExit = false;
        log(
            `[shift] ▶ ${username} на ${(ms / 60000).toFixed(1)}м` +
                (remainingMs != null ? ' (догон)' : ''),
        );
        await ctx.runWorker(bot);
        return true;
    }

    async function requestShiftStop(username) {
        const bot = ctx.bots.get(username);
        if (bot) bot.isManualStop = true;
        clearPendingRestart(username);
        expectingShiftExit = true;
        const posted = ctx.safePostMessage(username, { type: 'shift_stop' });
        if (!posted) {
            log(`[shift] ${username} нет IPC → terminate`);
            await ctx.stopWorkerNoRestart(username);
            expectingShiftExit = false;
            return;
        }
        await new Promise((resolve) => {
            stopWaitResolve = resolve;
            setTimeout(() => {
                if (stopWaitResolve === resolve) {
                    stopWaitResolve = null;
                    resolve('timeout');
                }
            }, SHIFT_STOP_WAIT_MS);
        });
        stopWaitResolve = null;
        expectingShiftExit = false;
        const entry = ctx.workers.get(username);
        if (entry?.worker && !entry.worker.terminated) {
            log(`[shift] ${username} не вышел после invest → terminate`);
            await ctx.stopWorkerNoRestart(username);
        }
    }

    /** @returns {boolean} true → орк не рестартует сам */
    function onWorkerExit(username, code) {
        if (username !== activeNick) {
            // чужой воркер в shift-mode не должен жить
            return true;
        }

        if (stopWaitResolve) {
            const r = stopWaitResolve;
            stopWaitResolve = null;
            r(code === EXIT_SHIFT_DONE ? 'done' : `exit:${code}`);
        }

        if (expectingShiftExit || code === EXIT_SHIFT_DONE) {
            return true;
        }

        const bot = ctx.bots.get(username);
        if (bot?.banned || bot?.authFault) {
            log(`[shift] ${username} бан/auth → следующий`);
            skipped.add(username);
            activeNick = null;
            shiftEndsAt = 0;
            resumeRemainingMs = null;
            return true;
        }

        const left = Math.max(0, shiftEndsAt - Date.now());
        if (left >= MIN_RESUME_MS) {
            resumeRemainingMs = left;
            log(`[shift] ${username} вылет, осталось ${(left / 60000).toFixed(1)}м → рестарт`);
            return true;
        }
        log(`[shift] ${username} вылет, остаток мал → следующий`);
        activeNick = null;
        shiftEndsAt = 0;
        resumeRemainingMs = null;
        return true;
    }

    async function skipBot(username, reason) {
        if (!username) return;
        skipped.add(username);
        if (username !== activeNick) return;

        log(`[shift] skip ${username} (${reason})`);
        const bot = ctx.bots.get(username);
        if (bot) bot.isManualStop = true;
        clearPendingRestart(username);
        resumeRemainingMs = null;
        shiftEndsAt = 0;
        await ctx.stopWorkerNoRestart(username);
        activeNick = null;
        void ctx.sendAlert?.(`⏭ shift skip ${username}: ${reason}`, username);
    }

    async function loop() {
        log('[shift] ротация включена');
        while (!stopped && !ctx.isShuttingDown()) {
            try {
                if (resumeRemainingMs != null && activeNick) {
                    const bot = ctx.bots.get(activeNick);
                    const left = resumeRemainingMs;
                    resumeRemainingMs = null;
                    if (bot && !bot.banned && !bot.authFault && !skipped.has(bot.username)) {
                        const ok = await startNick(bot, left);
                        if (!ok) {
                            activeNick = null;
                            continue;
                        }
                    } else {
                        activeNick = null;
                        continue;
                    }
                } else if (!activeNick || !ctx.workers.get(activeNick)?.worker) {
                    let pick = pickNextBot();
                    if (!pick && skipped.size) {
                        log('[shift] круг скипнут — сброс skip');
                        skipped.clear();
                        pick = pickNextBot();
                    }
                    if (!pick) {
                        log(`[shift] нет ботов — жду ${EMPTY_QUEUE_WAIT_MS / 1000}с`);
                        await sleep(EMPTY_QUEUE_WAIT_MS);
                        continue;
                    }
                    const ok = await startNick(pick, null);
                    if (!ok) continue;
                }

                while (
                    !stopped
                    && !ctx.isShuttingDown()
                    && activeNick
                    && Date.now() < shiftEndsAt
                ) {
                    const entry = ctx.workers.get(activeNick);
                    if (!entry?.worker || entry.worker.terminated) break;
                    await sleep(Math.min(5_000, Math.max(200, shiftEndsAt - Date.now())));
                }

                if (stopped || ctx.isShuttingDown()) break;

                if (
                    activeNick
                    && Date.now() >= shiftEndsAt
                    && ctx.workers.get(activeNick)?.worker
                    && !ctx.workers.get(activeNick).worker.terminated
                ) {
                    const doneNick = activeNick;
                    log(`[shift] время ${doneNick} → invest + стоп`);
                    await requestShiftStop(doneNick);
                    skipped.delete(doneNick);
                    activeNick = null;
                    shiftEndsAt = 0;
                    resumeRemainingMs = null;
                    await sleep(BETWEEN_SHIFTS_MS);
                    continue;
                }

                await sleep(BETWEEN_SHIFTS_MS);
            } catch (e) {
                log(`[shift] loop error: ${e?.message || e}`);
                await sleep(5_000);
            }
        }
        log('[shift] loop stop');
    }

    const api = {
        get active() {
            return Boolean(loopPromise) && !stopped;
        },
        get activeNick() {
            return activeNick;
        },
        ensureRunning() {
            if (!isShiftRotationEnabled()) return null;
            if (loopPromise) return loopPromise;
            stopped = false;
            loopPromise = loop().finally(() => {
                loopPromise = null;
            });
            return loopPromise;
        },
        async stop() {
            stopped = true;
            if (activeNick) {
                const bot = ctx.bots.get(activeNick);
                if (bot) bot.isManualStop = true;
                try {
                    await requestShiftStop(activeNick);
                } catch { /* ignore */ }
            }
            activeNick = null;
            if (loopPromise) await loopPromise.catch(() => {});
        },
        onWorkerExit,
        skipBot,
        onAlert(username, message) {
            if (!api.active) return false;
            const reason = shiftSkipReasonFromAlert(message);
            if (!reason) return false;
            void skipBot(username, reason);
            return true;
        },
    };
    return api;
}
