import test from 'node:test';
import assert from 'node:assert/strict';
import { computeCapitalPlan } from './capital-plan.mjs';
import { clanKeepSum } from './clan-save-sum.mjs';

test('equal share: rich + two broke → fair keep and maxBuy', () => {
    const plan = computeCapitalPlan({
        balances: [
            { username: 'rich', balance: 20_000_000 },
            { username: 'a', balance: 10_000 },
            { username: 'b', balance: 10_000 },
        ],
        treasury: 0,
    });
    assert.equal(plan.source, 'ledger');
    assert.equal(plan.mates, 3);
    assert.equal(plan.liquid, 20_020_000);
    assert.equal(plan.keepSum, Math.floor(20_020_000 / 3));
    assert.equal(plan.maxBuyPrice, Math.floor((20_020_000 / 3) * 0.9));
    // ~6.0kk: still above sword7, below deep mega list prices when market is high
    assert.ok(plan.maxBuyPrice > 1_000_000);
    assert.ok(plan.maxBuyPrice < 10_000_000);
});

test('treasury counts in liquid', () => {
    const plan = computeCapitalPlan({
        balances: [{ username: 'solo', balance: 1_000_000 }],
        treasury: 2_000_000,
    });
    assert.equal(plan.liquid, 3_000_000);
    assert.equal(plan.keepSum, 3_000_000);
    assert.equal(plan.maxBuyPrice, Math.floor(3_000_000 * 0.9));
});

test('no balances → clanKeepSum fallback', () => {
    const best = 5_500_007;
    const plan = computeCapitalPlan({
        balances: [],
        catalog: [{ priceSell: best }, { priceSell: 1_100_000 }],
        clanMates: 3,
    });
    assert.equal(plan.source, 'fallback');
    assert.equal(plan.keepSum, clanKeepSum(best, 3));
    assert.equal(plan.maxBuyPrice, Math.floor(plan.keepSum * 0.9));
});

test('single reported balance still splits by clanMates', () => {
    const plan = computeCapitalPlan({
        balances: [{ username: 'rich', balance: 20_000_000 }],
        clanMates: 3,
        treasury: 0,
    });
    assert.equal(plan.mates, 3);
    assert.equal(plan.keepSum, Math.floor(20_000_000 / 3));
    assert.equal(plan.maxBuyPrice, Math.floor((20_000_000 / 3) * 0.9));
});
