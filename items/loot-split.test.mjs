import assert from 'node:assert/strict';
import test from 'node:test';
import { findBestMatchingConfigItem } from './slotInfo.mjs';

/** Без сплита по добыче: loot мечи падают в sharp5/6/sword7. */
const catalog = [
    {
        id: 'sword7-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [
            { name: 'minecraft:unbreaking', lvl: 4 },
            { name: 'minecraft:fire_aspect', lvl: 1 },
            { name: 'minecraft:sharpness', lvl: 7 },
        ],
        num: 3,
        priceSell: 1_000_000,
        nacenka: 400_000,
    },
    {
        id: 'sword-sharp6-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [{ name: 'minecraft:sharpness', lvl: 6 }],
        num: 2,
        priceSell: 550_016,
        nacenka: 400_000,
    },
    {
        id: 'sword-sharp5-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [{ name: 'minecraft:sharpness', lvl: 5 }],
        num: 1,
        priceSell: 400_015,
        nacenka: 400_000,
    },
];

function sword(enchants = []) {
    return {
        name: 'netherite_sword',
        enchants: enchants.map((e) => ({ id: e.name, lvl: e.lvl })),
    };
}

test('sharp5+loot5 → sharp5 (no loot SKU)', () => {
    const item = sword([
        { name: 'minecraft:sharpness', lvl: 5 },
        { name: 'minecraft:looting', lvl: 5 },
    ]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword-sharp5-1.21');
});

test('sharp6+loot5 → sharp6', () => {
    const item = sword([
        { name: 'minecraft:sharpness', lvl: 6 },
        { name: 'minecraft:looting', lvl: 5 },
    ]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword-sharp6-1.21');
});

test('sharp7+loot4 full kit → sword7', () => {
    const item = sword([
        { name: 'minecraft:unbreaking', lvl: 4 },
        { name: 'minecraft:fire_aspect', lvl: 1 },
        { name: 'minecraft:sharpness', lvl: 7 },
        { name: 'minecraft:looting', lvl: 4 },
    ]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword7-1.21');
});

test('sharp7+loot5 farm kit → sword7', () => {
    const item = sword([
        { name: 'minecraft:unbreaking', lvl: 4 },
        { name: 'minecraft:fire_aspect', lvl: 1 },
        { name: 'minecraft:sharpness', lvl: 7 },
        { name: 'minecraft:looting', lvl: 5 },
    ]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword7-1.21');
});

test('sharp7+loot5 without unb/fa → sharp6 by num', () => {
    const item = sword([
        { name: 'minecraft:sharpness', lvl: 7 },
        { name: 'minecraft:looting', lvl: 5 },
    ]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword-sharp6-1.21');
});
