/**
 * Периодический заход владельца клана (clan-owners.json) → banned в presence /fleet.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { pingClanOwner } from './clan-owner-ping.mjs';

const FIRST_DELAY_MS = 5_000;
const INTERVAL_MS = 45 * 60 * 1000;

function loadJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * @param {{ anarchy: string|number, rootDir: string }} opts
 */
export function createClanOwnerBanWatch({ anarchy, rootDir }) {
    const an = String(anarchy).replace(/\D/g, '').slice(0, 3);
    /** @type {{ username: string, anarchy: number, banned: boolean, bannedAt: string|null, banReason: string, checkedAt: string|null }} */
    const state = {
        username: '',
        anarchy: Number(an) || 0,
        banned: false,
        bannedAt: null,
        banReason: '',
        checkedAt: null,
    };

    let running = false;
    let started = false;

    function loadOwnerAndProxy() {
        const ownersPath = join(rootDir, 'clan-owners.json');
        const ipPath = join(rootDir, 'ip.json');
        if (!existsSync(ownersPath) || !existsSync(ipPath)) {
            return null;
        }
        const owners = loadJson(ownersPath);
        const owner = owners[an];
        if (!owner?.username || !owner?.password) return null;
        const ipJson = loadJson(ipPath);
        const proxyString = ipJson[owner.ip || an];
        if (!proxyString) return null;
        return { owner, proxyString };
    }

    function getBannedForPresence() {
        if (!state.banned || !state.username) return [];
        return [{
            username: state.username,
            anarchy: state.anarchy,
            go_type: '',
            role: 'clan_owner',
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
            return;
        }
        const { owner, proxyString } = loaded;
        state.username = owner.username;
        state.anarchy = Number(owner.anarchy || an) || Number(an);

        running = true;
        log(`[clan-owner-watch] an${an} ping ${owner.username}…`);
        try {
            const result = await pingClanOwner({
                username: owner.username,
                password: owner.password,
                proxyString,
                log,
            });
            state.checkedAt = new Date().toISOString();

            if (result.status === 'banned') {
                const was = state.banned;
                state.banned = true;
                if (!state.bannedAt) state.bannedAt = state.checkedAt;
                state.banReason = result.reason || '';
                pushPresenceToGo?.();
                if (!was) {
                    await sendAlert?.(
                        `🚫 владелец клана ${owner.username} [an${an}] забанен`,
                        owner.username,
                    );
                }
                log(`[clan-owner-watch] an${an} BANNED ${owner.username}`);
            } else if (result.status === 'ok') {
                const was = state.banned;
                state.banned = false;
                state.bannedAt = null;
                state.banReason = '';
                pushPresenceToGo?.();
                if (was) {
                    await sendAlert?.(
                        `✅ владелец клана ${owner.username} [an${an}] снова онлайн`,
                        owner.username,
                    );
                }
                log(`[clan-owner-watch] an${an} ok ${owner.username}`);
            } else {
                log(`[clan-owner-watch] an${an} inconclusive: ${result.reason || '?'}`);
            }
        } catch (e) {
            log(`[clan-owner-watch] an${an} error: ${e.message}`);
        } finally {
            running = false;
        }
    }

    function start(hooks) {
        if (started) return;
        started = true;
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
        start,
        /** @internal для тестов */
        _state: state,
        _tick: tick,
    };
}
