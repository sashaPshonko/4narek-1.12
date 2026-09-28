import assert from 'node:assert/strict';
import test from 'node:test';
import { findBestMatchingConfigItem } from './slotInfo.mjs';

const catalog = [
    {
        id: 'фарм-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [
            { name: 'minecraft:unbreaking', lvl: 4 },
            { name: 'minecraft:fire_aspect', lvl: 1 },
            { name: 'minecraft:sharpness', lvl: 7 },
            { name: 'minecraft:looting', lvl: 5 },
        ],
        max_effects: [{ name: 'minecraft:sharpness', lvl: 7 }],
        num: 4,
        priceSell: 1_200_000,
        nacenka: 400_000,
    },
    {
        id: 'sword-sharp7-loot4-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [
            { name: 'minecraft:sharpness', lvl: 7 },
            { name: 'minecraft:looting', lvl: 4 },
        ],
        max_effects: [
            { name: 'minecraft:sharpness', lvl: 7 },
            { name: 'minecraft:looting', lvl: 4 },
        ],
        num: 3,
        priceSell: 700_019,
        nacenka: 400_000,
    },
    {
        id: 'sword-sharp6-loot5-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [
            { name: 'minecraft:sharpness', lvl: 6 },
            { name: 'minecraft:looting', lvl: 5 },
        ],
        max_effects: [
            { name: 'minecraft:sharpness', lvl: 6 },
            { name: 'minecraft:looting', lvl: 5 },
        ],
        num: 2,
        priceSell: 600_018,
        nacenka: 400_000,
    },
    {
        id: 'sword-sharp5-loot5-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [
            { name: 'minecraft:sharpness', lvl: 5 },
            { name: 'minecraft:looting', lvl: 5 },
        ],
        max_effects: [
            { name: 'minecraft:sharpness', lvl: 5 },
            { name: 'minecraft:looting', lvl: 5 },
        ],
        num: 2,
        priceSell: 450_017,
        nacenka: 400_000,
    },
    {
        id: 'sword-sharp5-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [{ name: 'minecraft:sharpness', lvl: 5 }],
        max_effects: [{ name: 'minecraft:sharpness', lvl: 5 }],
        num: 1,
        priceSell: 400_015,
        nacenka: 400_000,
    },
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
        nacenka: 400_000,
    },
];

function sword(enchants = []) {
    return {
        name: 'netherite_sword',
        enchants: enchants.map((e) => ({ id: e.name, lvl: e.lvl })),
    };
}

test('sharp5+loot5 → loot5 sku, not plain sharp5', () => {
    const item = sword([
        { name: 'minecraft:sharpness', lvl: 5 },
        { name: 'minecraft:looting', lvl: 5 },
    ]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword-sharp5-loot5-1.21');
});

test('sharp6+loot5 → loot5 sku', () => {
    const item = sword([
        { name: 'minecraft:sharpness', lvl: 6 },
        { name: 'minecraft:looting', lvl: 5 },
    ]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword-sharp6-loot5-1.21');
});

test('sharp7+loot4 → sharp7-loot4, not farm (loot5)', () => {
    const item = sword([
        { name: 'minecraft:unbreaking', lvl: 4 },
        { name: 'minecraft:fire_aspect', lvl: 1 },
        { name: 'minecraft:sharpness', lvl: 7 },
        { name: 'minecraft:looting', lvl: 4 },
    ]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'sword-sharp7-loot4-1.21');
});

test('sharp7+loot5 farm kit → farm', () => {
    const item = sword([
        { name: 'minecraft:unbreaking', lvl: 4 },
        { name: 'minecraft:fire_aspect', lvl: 1 },
        { name: 'minecraft:sharpness', lvl: 7 },
        { name: 'minecraft:looting', lvl: 5 },
    ]);
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'фарм-1.21');
});

test('sharp7+loot5 cannot fall into loot4 (max_effects)', () => {
    const item = sword([
        { name: 'minecraft:sharpness', lvl: 7 },
        { name: 'minecraft:looting', lvl: 5 },
    ]);
    assert.notEqual(findBestMatchingConfigItem(item, catalog)?.id, 'sword-sharp7-loot4-1.21');
});
