import assert from 'node:assert/strict';
import test from 'node:test';
import { findBestMatchingConfigItem } from './slotInfo.mjs';

/** Лестница почтимега → мега → яд3: только mins + num, без max_effects. */
const catalog = [
    {
        id: 'megasword-яд3-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [
            { name: 'minecraft:unbreaking', lvl: 3 },
            { name: 'minecraft:sharpness', lvl: 7 },
            { name: 'minecraft:fire_aspect', lvl: 1 },
            { name: 'poison', lvl: 3 },
            { name: 'detection', lvl: 3 },
        ],
        num: 7,
        priceSell: 4_000_007,
        nacenka: 300_000,
    },
    {
        id: 'megasword-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [
            { name: 'minecraft:unbreaking', lvl: 3 },
            { name: 'minecraft:sharpness', lvl: 7 },
            { name: 'minecraft:fire_aspect', lvl: 1 },
            { name: 'poison', lvl: 2 },
            { name: 'detection', lvl: 2 },
        ],
        num: 6,
        priceSell: 4_200_004,
        nacenka: 400_000,
    },
    {
        id: 'pochti-megasword-1.21',
        name: 'netherite_sword',
        type: 'netherite_sword-1.21',
        effects: [
            { name: 'minecraft:unbreaking', lvl: 3 },
            { name: 'minecraft:sharpness', lvl: 7 },
            { name: 'minecraft:fire_aspect', lvl: 1 },
            { name: 'poison', lvl: 1 },
            { name: 'detection', lvl: 1 },
        ],
        num: 5,
        priceSell: 3_000_002,
        nacenka: 300_000,
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
        num: 3,
        priceSell: 1_000_003,
        nacenka: 300_000,
    },
];

function sword(extra = []) {
    const base = [
        { name: 'minecraft:unbreaking', lvl: 3 },
        { name: 'minecraft:sharpness', lvl: 7 },
        { name: 'minecraft:fire_aspect', lvl: 1 },
    ];
    return {
        name: 'netherite_sword',
        enchants: [...base, ...extra].map((e) => ({ id: e.name, lvl: e.lvl })),
    };
}

test('яд1 дет1 → pochti', () => {
    assert.equal(
        findBestMatchingConfigItem(
            sword([
                { name: 'poison', lvl: 1 },
                { name: 'detection', lvl: 1 },
            ]),
            catalog,
        )?.id,
        'pochti-megasword-1.21',
    );
});

test('яд2 дет2 → mega', () => {
    assert.equal(
        findBestMatchingConfigItem(
            sword([
                { name: 'poison', lvl: 2 },
                { name: 'detection', lvl: 2 },
            ]),
            catalog,
        )?.id,
        'megasword-1.21',
    );
});

test('яд3 дет3 → яд3, not mega/pochti', () => {
    assert.equal(
        findBestMatchingConfigItem(
            sword([
                { name: 'poison', lvl: 3 },
                { name: 'detection', lvl: 3 },
            ]),
            catalog,
        )?.id,
        'megasword-яд3-1.21',
    );
});

test('яд3 дет2 (≥ mega mins) → mega, not pochti', () => {
    assert.equal(
        findBestMatchingConfigItem(
            sword([
                { name: 'poison', lvl: 3 },
                { name: 'detection', lvl: 2 },
            ]),
            catalog,
        )?.id,
        'megasword-1.21',
    );
});

test('яд4 дет4 still яд3 by >= mins', () => {
    assert.equal(
        findBestMatchingConfigItem(
            sword([
                { name: 'poison', lvl: 4 },
                { name: 'detection', lvl: 4 },
            ]),
            catalog,
        )?.id,
        'megasword-яд3-1.21',
    );
});
