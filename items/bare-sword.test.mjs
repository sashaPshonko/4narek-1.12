import assert from 'node:assert/strict';
import test from 'node:test';
import { findBestMatchingConfigItem } from './slotInfo.mjs';

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
        num: 1,
        priceSell: 1_000_000,
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

test('bare sword matches only when no enchants', () => {
    assert.equal(findBestMatchingConfigItem(sword([]), catalog)?.id, 'sword-bare-1.21');
});

test('enchanted sword still hits sword7, not bare', () => {
    const item = sword([
        { name: 'minecraft:unbreaking', lvl: 4 },
        { name: 'minecraft:fire_aspect', lvl: 1 },
        { name: 'minecraft:sharpness', lvl: 7 },
    ]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword7-1.21');
});

test('partial enchants do not fall into bare', () => {
    const item = sword([{ name: 'minecraft:sharpness', lvl: 5 }]);
    assert.equal(findBestMatchingConfigItem(item, catalog), null);
});
