/**
 * Pilot: движение/взгляд зрителя TLauncher → бот на FunTime.
 * Зрительские position игнорируем (физика бота); берём look + player_input.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const conv = require('mineflayer/lib/conversions');

const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint'];

function emptyControls() {
    return {
        forward: false,
        back: false,
        left: false,
        right: false,
        jump: false,
        sneak: false,
        sprint: false,
    };
}

/**
 * @param {import('mineflayer').Bot} bot
 * @param {{
 *   log?: Function,
 *   allowSprint?: boolean,
 *   onSample?: (controls: object) => void,
 *   ensurePhysicsOn?: (bot) => void,
 * }} [opts]
 */
export function createPilot(bot, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : console.log;
    const allowSprint = opts.allowSprint === true;
    const onSample = typeof opts.onSample === 'function' ? opts.onSample : null;
    const ensurePhysicsOn = typeof opts.ensurePhysicsOn === 'function' ? opts.ensurePhysicsOn : null;

    let enabled = false;
    const controls = emptyControls();

    function markPilot() {
        if (bot) bot._viewPilotActive = enabled;
    }

    function clearControls() {
        for (const k of CONTROL_KEYS) {
            controls[k] = false;
            try {
                bot?.setControlState?.(k, false);
            } catch {
                /* ignore */
            }
        }
    }

    function setEnabled(on) {
        const next = !!on;
        if (enabled === next) return enabled;
        enabled = next;
        markPilot();
        if (enabled) {
            if (ensurePhysicsOn) ensurePhysicsOn(bot);
            else if (bot) bot.physicsEnabled = true;
            log('pilot → ON (W/A/S/D + мышь с TLauncher → бот)');
        } else {
            clearControls();
            log('pilot → OFF');
        }
        return enabled;
    }

    function isEnabled() {
        return enabled;
    }

    function getControls() {
        return { ...controls };
    }

    function applyLookNotchian(yawDeg, pitchDeg) {
        if (!bot?.entity || !Number.isFinite(yawDeg) || !Number.isFinite(pitchDeg)) return;
        const yaw = conv.fromNotchianYaw(yawDeg);
        const pitch = conv.fromNotchianPitch(pitchDeg);
        // force: пакет уже пришёл с клиента с его rate — не ждём yawSpeed-очередь
        if (typeof bot.look === 'function') {
            bot.look(yaw, pitch, true).catch(() => {
                bot.entity.yaw = yaw;
                bot.entity.pitch = pitch;
            });
        } else {
            bot.entity.yaw = yaw;
            bot.entity.pitch = pitch;
        }
        onSample?.(getControls());
    }

    function applyInputs(inputs) {
        if (!inputs || typeof inputs !== 'object') return;
        const map = {
            forward: 'forward',
            backward: 'back',
            left: 'left',
            right: 'right',
            jump: 'jump',
            shift: 'sneak',
            sneak: 'sneak',
            sprint: 'sprint',
        };
        for (const [flag, control] of Object.entries(map)) {
            if (!Object.prototype.hasOwnProperty.call(inputs, flag)) continue;
            let val = !!inputs[flag];
            if (control === 'sprint' && !allowSprint) val = false;
            if (controls[control] === val) continue;
            controls[control] = val;
            try {
                bot.setControlState(control, val);
            } catch {
                /* ignore */
            }
        }
        onSample?.(getControls());
    }

    /**
     * Пакет от TLauncher (minecraft-protocol decoded).
     * @returns {boolean} true если обработали как motion
     */
    function handleSpectatorPacket(name, data) {
        if (!enabled || !bot?.entity) return false;
        if (!name) return false;

        if (name === 'look') {
            applyLookNotchian(data?.yaw, data?.pitch);
            return true;
        }
        if (name === 'position_look') {
            applyLookNotchian(data?.yaw, data?.pitch);
            // x/y/z зрителя не трогаем — ведём бота физикой
            return true;
        }
        if (name === 'position' || name === 'flying') {
            // ignore local spectator physics coords
            return true;
        }
        if (name === 'player_input') {
            applyInputs(data?.inputs || data);
            return true;
        }
        return false;
    }

    function dispose() {
        setEnabled(false);
        bot._viewPilotActive = false;
    }

    return {
        setEnabled,
        isEnabled,
        getControls,
        handleSpectatorPacket,
        clearControls,
        dispose,
    };
}

/** Чат-команды пилота/записи: !pilot, !rec, … */
export function parsePilotChatCommand(text) {
    const raw = String(text || '').trim();
    if (!raw.startsWith('!')) return null;
    const parts = raw.slice(1).trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    const arg = (parts[1] || '').toLowerCase();
    if (cmd === 'pilot') {
        if (arg === 'on' || arg === '1' || arg === 'start') return { type: 'pilot', on: true };
        if (arg === 'off' || arg === '0' || arg === 'stop') return { type: 'pilot', on: false };
        return { type: 'pilot_toggle' };
    }
    if (cmd === 'rec' || cmd === 'record') {
        if (arg === 'start' || arg === 'on') return { type: 'rec_start', tag: parts.slice(2).join('_') || 'walk' };
        if (arg === 'stop' || arg === 'off' || arg === 'end') return { type: 'rec_stop' };
        if (arg === 'status') return { type: 'rec_status' };
        return { type: 'rec_toggle', tag: arg || 'walk' };
    }
    if (cmd === 'help') return { type: 'help' };
    return null;
}
