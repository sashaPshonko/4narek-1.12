import test from 'node:test';
import assert from 'node:assert/strict';
import {
    botHasPricingStock,
    isBotAliveForPresence,
    collectActiveTypes,
    collectPresenceItemCounts,
    buildPresencePayload,
    markBotPresenceInactive,
} from '../orchestrator-shared.mjs';

function fakeWorker() {
    return { worker: { terminated: false } };
}

function setupSwordBot({ inactive = false, reason = '', ah = [], inv = [] } = {}) {
    const bots = new Map([
        ['swordBot', {
            username: 'swordBot',
            success: true,
            goType: 'netherite_sword-1.21',
            type: '4narek-old',
            presenceInactive: inactive,
            presenceInactiveReason: reason,
        }],
    ]);
    const workers = new Map([['swordBot', fakeWorker()]]);
    const botItems = new Map([['swordBot', ah]]);
    const botInventory = new Map([['swordBot', inv]]);
    return { bots, workers, botItems, botInventory };
}

test('botHasPricingStock: AH or inventory', () => {
    const items = new Map([['a', ['megasword-1.21']]]);
    const inv = new Map([['a', []]]);
    assert.equal(botHasPricingStock('a', items, inv), true);
    assert.equal(botHasPricingStock('a', new Map([['a', []]]), new Map([['a', ['фарм-1.21']]])), true);
    assert.equal(botHasPricingStock('a', new Map([['a', []]]), new Map([['a', []]])), false);
});

test('treasury_empty without stock → not alive for presence', () => {
    const ctx = setupSwordBot({ inactive: true, reason: 'treasury_empty', ah: [], inv: [] });
    assert.equal(
        isBotAliveForPresence('swordBot', ctx.bots, ctx.workers, ctx.botItems, ctx.botInventory),
        false,
    );
    assert.deepEqual(collectActiveTypes(ctx.bots, ctx.workers, ctx.botItems, ctx.botInventory), []);
});

test('treasury_empty with AH stock → alive + active_types + counts', () => {
    const ctx = setupSwordBot({
        inactive: true,
        reason: 'treasury_empty',
        ah: ['megasword-1.21', 'megasword-1.21'],
        inv: [],
    });
    assert.equal(
        isBotAliveForPresence('swordBot', ctx.bots, ctx.workers, ctx.botItems, ctx.botInventory),
        true,
    );
    assert.deepEqual(
        collectActiveTypes(ctx.bots, ctx.workers, ctx.botItems, ctx.botInventory),
        ['netherite_sword-1.21'],
    );
    const counts = collectPresenceItemCounts(ctx.bots, ctx.workers, ctx.botItems, ctx.botInventory);
    assert.equal(counts.items['megasword-1.21'], 2);
});

test('staff_check with stock → still excluded', () => {
    const ctx = setupSwordBot({
        inactive: true,
        reason: 'staff_check',
        ah: ['megasword-1.21'],
        inv: ['фарм-1.21'],
    });
    assert.equal(
        isBotAliveForPresence('swordBot', ctx.bots, ctx.workers, ctx.botItems, ctx.botInventory),
        false,
    );
    const payload = buildPresencePayload(ctx.bots, ctx.workers, ctx.botItems, ctx.botInventory);
    assert.deepEqual(payload.active_types, []);
    assert.deepEqual(payload.items, {});
});

test('markBotPresenceInactive treasury_empty keeps slots', () => {
    const ctx = setupSwordBot({ ah: ['megasword-1.21'], inv: ['sword7-1.21'] });
    const orch = {
        bots: ctx.bots,
        botItems: ctx.botItems,
        botInventory: ctx.botInventory,
        pushPresenceToGo: () => {},
    };
    assert.equal(markBotPresenceInactive('swordBot', orch, 'treasury_empty'), true);
    assert.deepEqual(ctx.botItems.get('swordBot'), ['megasword-1.21']);
    assert.deepEqual(ctx.botInventory.get('swordBot'), ['sword7-1.21']);
    assert.deepEqual(
        collectActiveTypes(ctx.bots, ctx.workers, ctx.botItems, ctx.botInventory),
        ['netherite_sword-1.21'],
    );
});

test('markBotPresenceInactive staff_check clears slots', () => {
    const ctx = setupSwordBot({ ah: ['megasword-1.21'], inv: ['sword7-1.21'] });
    const orch = {
        bots: ctx.bots,
        botItems: ctx.botItems,
        botInventory: ctx.botInventory,
        pushPresenceToGo: () => {},
    };
    assert.equal(markBotPresenceInactive('swordBot', orch, 'staff_check'), true);
    assert.equal(ctx.botItems.has('swordBot'), false);
    assert.equal(ctx.botInventory.has('swordBot'), false);
});
