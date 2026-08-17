/**
 * Периодический заход владельца клана (clan-owners.json) → статус в presence /fleet.
 */
import { pingClanOwner } from './clan-owner-ping.mjs';
import { loadClanOwnerSession } from './owner-proxy.mjs';

const FIRST_DELAY_MS = 5_000;
const INTERVAL_MS = 45 * 60 * 1000;
/** Ошибка пинга (connection end и т.п.) — не финал, пробуем снова. */
const MAX_PING_ATTEMPTS = 8;
const RETRY_DELAY_MS = 12_000;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
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
    };

    let running = false;
    let started = false;

    function loadOwnerAndProxy() {
        return loadClanOwnerSession(rootDir, an);
    }

    function refreshIdentity() {
        const loaded = loadOwnerAndProxy();
        if (!loaded) return false;
        state.username = loaded.owner.username;
        state.anarchy = Number(loaded.owner.anarchy || an) || Number(an);
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
        }];
    }

    async function tick({ pushPresenceToGo, sendAlert, log = console.log }) {
        if (running) {
            log(`[clan-owner-watch] an${an} уже идёт — skip`);
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

        running = true;
        state.status = 'pending';
        state.lastError = '';
        pushPresenceToGo?.();
        log(`[clan-owner-watch] an${an} ping ${owner.username}…`);
        try {
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

                if (result.status === 'ok' || result.status === 'banned') break;

                log(
                    `[clan-owner-watch] an${an} attempt ${attempt}/${MAX_PING_ATTEMPTS}: ${result.reason || 'error'} — ещё раз`,
                );
                if (attempt < MAX_PING_ATTEMPTS) await sleep(RETRY_DELAY_MS);
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
                if (!was) {
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
        refreshIdentity();
        // сразу в presence как pending — видно на /fleet до первого пинга
        hooks.pushPresenceToGo?.();
        const run = () => {
            void tick(hooks);
        };
        setTimeout(run, FIRST_DELAY_MS);
        setInterval(run, INTERVAL_MS);
        console.log(
            `[clan-owner-watch] an${an} стартовал (первый через ${FIRST_DELAY_MS / 1000}с, далее каждые ${INTERVAL_MS / 60000}м)`,
        );
    }

    return {
        getBannedForPresence,
        getOwnerForPresence,
        start,
        _state: state,
        _tick: tick,
    };
}
