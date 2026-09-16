/**
 * FIX WALKING BOT 1.21+: player_input + tick_end как у ванили.
 *
 * mineflayer 4.37 шлёт player_input только для sneak (урезанный), tick_end не шлёт.
 * Здесь: полный bitset при смене клавиши; tick_end после move-пакетов тика;
 * hasHorizontalCollision всегда bool.
 *
 * @param {import('mineflayer').Bot} bot
 */
export function patchWalking121(bot) {
    if (!bot || bot._walk121Patched) return;
    bot._walk121Patched = true;
    bot._vanillaMovePatched = true;

    if (typeof bot.setControlState === 'function' && bot._client) {
        applyWalkPatch(bot);
    } else {
        bot.once('inject_allowed', () => setTimeout(() => applyWalkPatch(bot), 0));
    }
}

const CONTROL_TO_INPUT = {
    forward: 'forward',
    back: 'backward',
    left: 'left',
    right: 'right',
    jump: 'jump',
    sneak: 'shift',
    sprint: 'sprint',
};

const INPUT_FLAG_TO_CONTROL = {
    forward: 'forward',
    backward: 'back',
    left: 'left',
    right: 'right',
    jump: 'jump',
    shift: 'sneak',
    sprint: 'sprint',
};

const MOVE_PACKET_NAMES = new Set(['position', 'look', 'position_look', 'flying']);

function fullInputsFrom(controlState) {
    const inputs = {};
    for (const [control, flag] of Object.entries(CONTROL_TO_INPUT)) {
        inputs[flag] = !!controlState[control];
    }
    return inputs;
}

function applyWalkPatch(bot) {
    if (typeof bot.setControlState !== 'function') return;
    if (bot._walk121Controls) return;
    const client = bot._client;
    if (!client || typeof client.write !== 'function') return;

    const controlState = {
        forward: false,
        back: false,
        left: false,
        right: false,
        jump: false,
        sprint: false,
        sneak: false,
    };
    bot._walk121Controls = controlState;
    bot._vanillaMoveControls = controlState;
    const origSetControlState = bot.setControlState.bind(bot);
    const rawWrite = client.write.bind(client);
    let suppressPlayerInput = false;
    let tickEndQueued = false;

    const writeInputs = () => {
        if (client.state !== 'play') return;
        try {
            rawWrite('player_input', { inputs: fullInputsFrom(controlState) });
        } catch {
            /* ignore */
        }
    };

    const fixMoveFlags = (params) => {
        if (!params || typeof params !== 'object') return params;
        const onGround = !!(params.onGround ?? params.flags?.onGround);
        const horiz = !!(params.flags?.hasHorizontalCollision);
        params.onGround = onGround;
        params.flags = { onGround, hasHorizontalCollision: horiz };
        return params;
    };

    const queueTickEnd = () => {
        if (tickEndQueued) return;
        tickEndQueued = true;
        queueMicrotask(() => {
            tickEndQueued = false;
            if (client.state !== 'play') return;
            try {
                rawWrite('tick_end', {});
            } catch {
                /* ignore */
            }
        });
    };

    client.write = (name, params) => {
        if (name === 'player_input') {
            if (suppressPlayerInput) return;
            if (client.state !== 'play') return;
            const partial = params?.inputs;
            if (partial && typeof partial === 'object') {
                for (const [flag, control] of Object.entries(INPUT_FLAG_TO_CONTROL)) {
                    if (Object.prototype.hasOwnProperty.call(partial, flag)) {
                        controlState[control] = !!partial[flag];
                    }
                }
            }
            return rawWrite('player_input', { inputs: fullInputsFrom(controlState) });
        }
        if (MOVE_PACKET_NAMES.has(name)) {
            const out = rawWrite(name, fixMoveFlags(params));
            queueTickEnd();
            return out;
        }
        return rawWrite(name, params);
    };

    bot.setControlState = function setControlState121(control, state) {
        if (!(control in controlState) || typeof state !== 'boolean') {
            return origSetControlState(control, state);
        }
        if (controlState[control] === state) return;
        controlState[control] = state;

        suppressPlayerInput = true;
        let result;
        try {
            result = origSetControlState(control, state);
        } finally {
            suppressPlayerInput = false;
        }
        writeInputs();
        return result;
    };

    bot.refreshPlayerInput = writeInputs;

    bot.on('physicsTick', () => {
        if (client.state !== 'play') return;
        queueTickEnd();
    });
}
