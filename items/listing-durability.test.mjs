import assert from 'node:assert/strict';
import test from 'node:test';
import { expectedSellFromListingMeta, priceWithDurability } from './slotInfo.mjs';
import { pricesMatch } from './listing-memory.mjs';

const catalog = [
    {
        id: 'sword-sharp6-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        priceSell: 1_127_400,
        nacenka: 300_000,
    },
];

test('priceWithDurability ~75% of sharp6 ≈ 850k', () => {
    const p = priceWithDurability(1_127_400, 0.754);
    assert.equal(p, 850_000);
});

test('AH NBT dur flip: memory dur keeps match', () => {
    const listed = priceWithDurability(1_127_400, 0.754); // 850000 as at /ah sell
    const ahLore = listed + 3; // listing id 3
    // Storage wrongly reads 100% → old bug expected 1127400
    const wrongAhNbt = priceWithDurability(1_127_400, 1);
    assert.equal(wrongAhNbt, 1_127_400);
    assert.equal(pricesMatch(ahLore, wrongAhNbt), false);

    const expected = expectedSellFromListingMeta(catalog, {
        catalogId: 'sword-sharp6-1.21',
        durability: 0.754,
    });
    assert.equal(expected, 850_000);
    assert.equal(pricesMatch(ahLore, expected), true);
});

test('Go price change still mismatches', () => {
    const catalogUp = [{ ...catalog[0], priceSell: 1_200_000 }];
    const expected = expectedSellFromListingMeta(catalogUp, {
        catalogId: 'sword-sharp6-1.21',
        durability: 0.754,
    });
    assert.ok(expected > 850_000);
    assert.equal(pricesMatch(850_003, expected), false);
});

test('pricesAligned tolerates Go micro-tick', async () => {
    const { pricesAligned } = await import('./listing-memory.mjs');
    assert.equal(pricesAligned(830_000, 829_900), true);
    assert.equal(pricesAligned(950_002, 500_000), false);
});
