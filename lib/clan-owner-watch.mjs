/**
 * Редкий health-check владельца клана → статус в presence /fleet.
 * Логин только через Go launch-gate (та же очередь, что у ботов).
 * Интервал — случайный (часы), без общего 45м ритма.
 */
import { pingClanOwner, isNickAlreadyOnlineText } from './clan-owner-ping.mjs';
import { reportClanOwnerToGo } from './clan-owner-go.mjs';
import { loadClanOwnerSession } from './owner-proxy.mjs';
import { proxyHostFromString } from './proxy-host.mjs';
import { awaitFleetLaunchGrant } from './fleet-launch-gate.mjs';

/** Ошибка пинга — мало попыток: каждая жрёт слот launch-gate. */
const MAX_PING_ATTEMPTS = 2;
const RETRY_DELAY_MS = 12_000;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function rndInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

/** Первый пинг не сразу после старта орха: 90–360 мин + сдвиг по анке. */
function firstDelayMs(an) {
    const anNum = Number(an) || 0;
    return (90 + rndInt(0, 270)) * 60_000 + (anNum % 5) * 11 * 60_000;
}

/** Между пингами: 8–18 ч + сдвиг по анке (502/504 не в фазе). */
function nextIntervalMs(an) {
    const anNum = Number(an) || 0;
    return (8 * 3600_000) + rndInt(0, 10 * 3600_000) + (anNum % 7) * 17 * 60_000;
}

/**
 * @param {{ anarchy: string|number, rootDir: string }} opts
 */
export function createClanOwnerBanWatch({ anarchy, rootDir }) {
    const an = String(anarchy).replace(/\D/g, '').slice(0, 3);
    /** @type {{
     *   username: string,
     *   anarchy: number,
     *   status: 'pending'|'ok'|'banned'|'error',
     *   banned: boolean,
     *   bannedAt: string|null,
     *   banReason: string,
     *   checkedAt: string|null,
     *   lastError: string,
     * }} */
    const state = {
        username: '',
        anarchy: Number(an) || 0,
        status: 'pending',
        banned: false,
        bannedAt: null,
        banReason: '',
        checkedAt: null,
        lastError: '',
        proxyHost: '',
    };

    let running = false;
    let started = false;
    let timer = null;
    /** @type {any} */
    let hooksRef = null;

    function loadOwnerAndProxy() {
        return loadClanOwnerSession(rootDir, an);
    }

    function refreshIdentity() {
        const loaded = loadOwnerAndProxy();
        if (!loaded) return false;
        state.username = loaded.owner.username;
        state.anarchy = Number(loaded.owner.anarchy || an) || Number(an);
        state.proxyHost = proxyHostFromString(loaded.proxyString);
        return true;
    }

    /** Всегда один владелец этой анки — для блока на /fleet. */
    function getOwnerForPresence() {
        if (!state.username && !refreshIdentity()) return [];
        if (!state.username) return [];
        return [{
            username: state.username,
            anarchy: state.anarchy,
            status: state.status,
            banned: !!state.banned,
            banned_at: state.bannedAt || null,
            reason: state.banReason || state.lastError || '',
            checked_at: state.checkedAt || null,
            ip: state.proxyHost || '',
        }];
    }

    function getBannedForPresence() {
        if (!state.banned || !state.username) return [];
        return [{
            username: state.username,
            anarchy: state.anarchy,
            go_type: '',
            banned_at: state.bannedAt || null,
            reason: state.banReason || '',
            ip: state.proxyHost || '',
        }];
    }

    function scheduleNext(ms, log = console.log) {
        if (timer) clearTimeout(timer);
        const wait = Math.max(60_000, ms);
        timer = setTimeout(() => {
            void (async () => {
                if (hooksRef) await tick(hooksRef);
                if (state.banned) {
                    log(`[clan-owner-watch] an${an} banned — further pings stopped`);
                    return;
                }
                const next = nextIntervalMs(an);
                log(`[clan-owner-watch] an${an} next ping in ~${(next / 3600000).toFixed(1)}h`);
                scheduleNext(next, log);
            })();
        }, wait);
    }

    async function tick({ pushPresenceToGo, sendAlert, log = console.log, notifyWorkersOwnerBanned } = {}) {
        const hooks = {
            pushPresenceToGo,
            sendAlert,
            log,
            notifyWorkersOwnerBanned,
        };
        if (running) {
            log(`[clan-owner-watch] an${an} уже идёт — skip`);
            return;
        }
        if (state.banned) {
            log(`[clan-owner-watch] an${an} already banned — skip`);
            return;
        }
        const loaded = loadOwnerAndProxy();
        if (!loaded) {
            log(`[clan-owner-watch] an${an} нет owner/proxy`);
            state.status = 'error';
            state.lastError = 'нет owner/proxy (owner-ip.json)';
            pushPresenceToGo?.();
            return;
        }
        const { owner, proxyString } = loaded;
        state.username = owner.username;
        state.anarchy = Number(owner.anarchy || an) || Number(an);
        state.proxyHost = proxyHostFromString(proxyString);

        running = true;
        state.status = 'pending';
        state.lastError = '';
        pushPresenceToGo?.();
        log(`[clan-owner-watch] an${an} ping ${owner.username}…`);
        try {
            const granted = await awaitFleetLaunchGrant({
                username: owner.username,
                anarchy: state.anarchy || an,
                kind: 'owner',
                log,
            });
            if (!granted) {
                state.status = 'error';
                state.lastError = 'launch-gate aborted';
                pushPresenceToGo?.();
                return;
            }

            /** @type {{ status: string, reason?: string }|null} */
            let result = null;
            for (let attempt = 1; attempt <= MAX_PING_ATTEMPTS; attempt++) {
                try {
                    result = await pingClanOwner({
                        username: owner.username,
                        password: owner.password,
                        proxyString,
                        anarchy: state.anarchy || an,
                        log,
                    });
                } catch (e) {
                    result = { status: 'error', reason: e.message || 'error' };
                }

                if (result.status === 'error' && isNickAlreadyOnlineText(result.reason)) {
                    result = { status: 'ok', reason: 'ник уже онлайн (другой клиент)' };
                }
                if (result.status === 'ok' || result.status === 'banned') break;

                log(
                    `[clan-owner-watch] an${an} attempt ${attempt}/${MAX_PING_ATTEMPTS}: ${result.reason || 'error'} — ещё раз`,
                );
                if (attempt < MAX_PING_ATTEMPTS) {
                    await awaitFleetLaunchGrant({
                        username: owner.username,
                        anarchy: state.anarchy || an,
                        kind: 'owner',
                        log,
                    });
                    await sleep(RETRY_DELAY_MS);
                }
            }

            state.checkedAt = new Date().toISOString();

            if (result?.status === 'banned') {
                const was = state.banned;
                state.banned = true;
                state.status = 'banned';
                if (!state.bannedAt) state.bannedAt = state.checkedAt;
                state.banReason = result.reason || '';
                state.lastError = '';
                pushPresenceToGo?.();
                reportClanOwnerToGo({
                    username: owner.username,
                    anarchy: state.anarchy,
                    status: 'banned',
                    banned: true,
                    reason: state.banReason,
                    bannedAt: state.bannedAt,
                    checkedAt: state.checkedAt,
                    ip: state.proxyHost,
                });
                if (!was) {
                    hooks.notifyWorkersOwnerBanned?.({
                        owner: owner.username,
                        anarchy: Number(an) || state.anarchy,
                        reason: state.banReason,
                    });
                    await sendAlert?.(
                        `🚫 владелец клана ${owner.username} [an${an}] забанен`,
                        owner.username,
                    );
                }
                log(`[clan-owner-watch] an${an} BANNED ${owner.username}`);
            } else if (result?.status === 'ok') {
                const was = state.banned;
                state.banned = false;
                state.status = 'ok';
                state.bannedAt = null;
                state.banReason = '';
                state.lastError = '';
                pushPresenceToGo?.();
                reportClanOwnerToGo({
                    username: owner.username,
                    anarchy: state.anarchy,
                    status: 'ok',
                    banned: false,
                    checkedAt: state.checkedAt,
                    ip: state.proxyHost,
                });
                if (was) {
                    await sendAlert?.(
                        `✅ владелец клана ${owner.username} [an${an}] снова онлайн`,
                        owner.username,
                    );
                }
                log(`[clan-owner-watch] an${an} ok ${owner.username}`);
            } else {
                state.status = 'error';
                state.lastError = result?.reason || 'error';
                pushPresenceToGo?.();
                log(
                    `[clan-owner-watch] an${an} после ${MAX_PING_ATTEMPTS} попыток: ${result?.reason || '?'}`,
                );
            }
        } catch (e) {
            state.status = 'error';
            state.lastError = e.message || 'error';
            state.checkedAt = new Date().toISOString();
            pushPresenceToGo?.();
            log(`[clan-owner-watch] an${an} error: ${e.message}`);
        } finally {
            running = false;
        }
    }

    function start(hooks) {
        if (started) return;
        started = true;
        hooksRef = hooks;
        refreshIdentity();
        hooks.pushPresenceToGo?.();
        const first = firstDelayMs(an);
        const log = hooks.log || console.log;
        log(
            `[clan-owner-watch] an${an} стартовал — первый ping через ~${(first / 3600000).toFixed(1)}h`
            + ` (далее 8–18h random, через launch-gate)`,
        );
        scheduleNext(first, log);
    }

    return {
        getBannedForPresence,
        getOwnerForPresence,
        start,
        _state: state,
        _tick: tick,
    };
}
