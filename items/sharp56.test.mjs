import assert from 'node:assert/strict';
import test from 'node:test';
import { findBestMatchingConfigItem } from './slotInfo.mjs';

/** Минимальный каталог: sharp5/6 + sword7 + bare — как в проде после сплита. */
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
        max_effects: [{ name: 'minecraft:sharpness', lvl: 7 }],
        num: 1,
        priceSell: 1_000_000,
        nacenka: 300_000,
    },
    {
        id: 'sword-sharp6-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [{ name: 'minecraft:sharpness', lvl: 6 }],
        max_effects: [{ name: 'minecraft:sharpness', lvl: 6 }],
        num: 1,
        priceSell: 550_016,
        nacenka: 300_000,
    },
    {
        id: 'sword-sharp5-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [{ name: 'minecraft:sharpness', lvl: 5 }],
        max_effects: [{ name: 'minecraft:sharpness', lvl: 5 }],
        num: 1,
        priceSell: 400_015,
        nacenka: 300_000,
    },
    {
        id: 'sword-bare-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [],
        exact_effects: true,
        num: 0,
        priceSell: 80_019,
        nacenka: 30_000,
    },
];

function sword(enchants = []) {
    return {
        name: 'netherite_sword',
        enchants: enchants.map((e) => ({ id: e.name, lvl: e.lvl })),
    };
}

test('sharp5 only → sword-sharp5', () => {
    const item = sword([{ name: 'minecraft:sharpness', lvl: 5 }]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword-sharp5-1.21');
});

test('sharp6 only → sword-sharp6', () => {
    const item = sword([{ name: 'minecraft:sharpness', lvl: 6 }]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword-sharp6-1.21');
});

test('sharp5 + other enchants still sharp5 (not bare, not 7)', () => {
    const item = sword([
        { name: 'minecraft:sharpness', lvl: 5 },
        { name: 'minecraft:unbreaking', lvl: 3 },
    ]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword-sharp5-1.21');
});

test('sharp6 does not fall into sharp5 (max_effects)', () => {
    const item = sword([{ name: 'minecraft:sharpness', lvl: 6 }]);
    assert.notEqual(findBestMatchingConfigItem(item, catalog)?.id, 'sword-sharp5-1.21');
});

test('sharp7 kit still sword7, not sharp5/6', () => {
    const item = sword([
        { name: 'minecraft:unbreaking', lvl: 4 },
        { name: 'minecraft:fire_aspect', lvl: 1 },
        { name: 'minecraft:sharpness', lvl: 7 },
    ]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword7-1.21');
});

test('bare unchanged', () => {
    assert.equal(findBestMatchingConfigItem(sword([]), catalog)?.id, 'sword-bare-1.21');
});
