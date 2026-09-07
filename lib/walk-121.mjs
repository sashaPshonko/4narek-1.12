/**
 * FIX WALKING BOT 1.21+: player_input + tick_end.
 *
 * mineflayer 4.37 шлёт player_input только для sneak, а tick_end не шлёт вовсе,
 * поэтому на 1.21.6+ сервер не видит нажатий WASD.
 *
 * Важно: player_input надо **повторять каждый тик**, пока клавиши зажаты —
 * иначе после look/прочего сервер «забывает» WASD (forward остаётся true
 * локально, setControlState early-return, а на сервере уже idle).
 *
 * physicsTick — когда physics включён.
 * Fallback 50мс — когда physicsEnabled: false (наши воркеры).
 *
 * @param {import('mineflayer').Bot} bot
 */
export function patchWalking121(bot) {
    if (!bot || bot._walk121Patched) return;
    bot._walk121Patched = true;

    // Плагины mineflayer (в т.ч. physics с setControlState) инжектятся на inject_allowed.
    if (typeof bot.setControlState === 'function') {
        applyWalkPatch(bot);
    } else {
        bot.once('inject_allowed', () => setTimeout(() => applyWalkPatch(bot), 0));
    }
}

/** В протоколе 1.21+ флаг называется backward, а контрол mineflayer — back. */
const CONTROL_TO_INPUT = {
    forward: 'forward',
    back: 'backward',
    left: 'left',
    right: 'right',
    jump: 'jump',
    sneak: 'shift',
    sprint: 'sprint',
};

function applyWalkPatch(bot) {
    if (typeof bot.setControlState !== 'function') return;
    if (bot._walk121Controls) return;

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
    const origSetControlState = bot.setControlState.bind(bot);

    const writeInputs = () => {
        if (bot._client?.state !== 'play') return;
        const inputs = {};
        for (const [control, flag] of Object.entries(CONTROL_TO_INPUT)) {
            inputs[flag] = controlState[control];
        }
        try {
            bot._client.write('player_input', { inputs });
        } catch {
            /* ignore */
        }
    };

    /** Принудительно повторить текущие WASD (после look / каждый тик). */
    bot.refreshPlayerInput = writeInputs;

    bot.setControlState = function setControlState121(control, state) {
        if (!(control in controlState) || typeof state !== 'boolean') {
            return origSetControlState(control, state);
        }
        const changed = controlState[control] !== state;
        controlState[control] = state;
        const result = origSetControlState(control, state);
        // даже без смены — refresh: look мог сбросить серверный input
        writeInputs();
        if (!changed) {
            /* already refreshed */
        }
        return result;
    };

    let lastPhysicsTickAt = 0;
    let fallbackTimer = null;

    const writeTickEnd = () => {
        if (bot._client?.state !== 'play') return;
        try {
            bot._client.write('tick_end', {});
        } catch {
            /* ignore */
        }
    };

    const pulse = () => {
        writeInputs();
        writeTickEnd();
    };

    bot.on('physicsTick', () => {
        lastPhysicsTickAt = Date.now();
        pulse();
    });

    const startFallback = () => {
        if (fallbackTimer) return;
        fallbackTimer = setInterval(() => {
            // если physics крутится часто — physicsTick уже пульсирует
            if (Date.now() - lastPhysicsTickAt < 40) return;
            pulse();
        }, 50);
    };

    const stopFallback = () => {
        if (!fallbackTimer) return;
        clearInterval(fallbackTimer);
        fallbackTimer = null;
    };

    bot.on('spawn', startFallback);
    bot.on('end', stopFallback);
    bot.on('kicked', stopFallback);
    if (bot._client?.state === 'play') startFallback();
}
