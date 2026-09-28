import test from 'node:test';
import assert from 'node:assert/strict';
import { clanKeepSum } from './clan-save-sum.mjs';

test('solo keeps full 5× pool', () => {
    assert.equal(clanKeepSum(5_500_007, 1), 5_500_007 * 5);
});

test('3 mates share remainder after 1× top', () => {
    const best = 5_500_007;
    const keep = clanKeepSum(best, 3);
    assert.equal(keep, Math.ceil(best * (1 + 4 / 3)));
    assert.ok(keep < best * 5);
    assert.ok(keep > best * 2);
});

test('invalid price → null', () => {
    assert.equal(clanKeepSum(0, 3), null);
    assert.equal(clanKeepSum(null, 3), null);
});
