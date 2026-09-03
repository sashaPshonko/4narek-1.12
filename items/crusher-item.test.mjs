import test from 'node:test';
import assert from 'node:assert/strict';
import { isFunTimeCrusherItem, findBestMatchingConfigItem, skipAhBookArmorMending, skipAhBookCrusher, itemMatchesCrusherKit } from './slotInfo.mjs';

function named(text, extra = {}) {
    return {
        name: 'netherite_sword',
        components: [
            {
                type: 'custom_name',
                data: {
                    type: 'compound',
                    value: {
                        extra: {
                            type: 'list',
                            value: {
                                type: 'compound',
                                value: [{ text: { type: 'string', value: text } }],
                            },
                        },
                        text: { type: 'string', value: '' },
                    },
                },
            },
        ],
        ...extra,
    };
}

function splitName(parts) {
    return {
        name: 'netherite_helmet',
        components: [
            {
                type: 'custom_name',
                data: {
                    type: 'compound',
                    value: {
                        extra: {
                            type: 'list',
                            value: {
                                type: 'compound',
                                value: parts.map((t) => ({
                                    text: { type: 'string', value: t },
                                })),
                            },
                        },
                        text: { type: 'string', value: '' },
                    },
                },
            },
        ],
    };
}

function loreOriginal() {
    const parts = ['О', 'ригинальн', 'ый', ' ', 'п', 'редмет'];
    return {
        name: 'netherite_boots',
        components: [
            {
                type: 'custom_name',
                data: {
                    type: 'compound',
                    value: {
                        extra: {
                            type: 'list',
                            value: {
                                type: 'compound',
                                value: [{ text: { type: 'string', value: 'by TE_AMO' } }],
                            },
                        },
                        text: { type: 'string', value: '' },
                    },
                },
            },
            {
                type: 'lore',
                data: [
                    {
                        extra: {
                            type: 'list',
                            value: {
                                type: 'compound',
                                value: parts.map((t) => ({
                                    text: { type: 'string', value: t },
                                })),
                            },
                        },
                    },
                ],
            },
        ],
    };
}

test('crusher custom_name skipped', () => {
    assert.equal(isFunTimeCrusherItem(named('Меч крушителя')), true);
    assert.equal(isFunTimeCrusherItem(named('Шлем крушителя')), true);
    assert.equal(isFunTimeCrusherItem(named('***psychowhore***')), false);
    assert.equal(isFunTimeCrusherItem({ name: 'netherite_sword', displayName: 'Netherite Sword' }), false);
});

test('split custom_name Шлем Крушителя', () => {
    const item = splitName(['xxx', ' ', 'Ш', 'л', 'е', 'м', ' ', 'К', 'ру', 'ш', 'и', 'т', 'е', 'л', 'я', ' ', 'xxx']);
    assert.equal(isFunTimeCrusherItem(item), true);
});

test('renamed original lore is not enough', () => {
    assert.equal(isFunTimeCrusherItem(loreOriginal()), false);
    assert.equal(skipAhBookCrusher(loreOriginal()), false);
});

test('named crusher skipped for AH book, catalog match unchanged', () => {
    const catalog = [
        {
            id: 'megasword-яд3-1.21',
            type: 'netherite_sword-1.21',
            name: 'netherite_sword',
            num: 7,
            effects: [],
        },
    ];
    const item = named('Меч крушителя');
    assert.equal(findBestMatchingConfigItem(item, catalog)?.id, 'megasword-яд3-1.21');
    assert.equal(skipAhBookCrusher(item), true);
});

test('crusher helmet kit by enchants skips AH book', () => {
    const item = {
        name: 'netherite_helmet',
        enchants: [
            { name: 'minecraft:protection', lvl: 5 },
            { name: 'minecraft:blast_protection', lvl: 5 },
            { name: 'minecraft:fire_protection', lvl: 5 },
            { name: 'minecraft:projectile_protection', lvl: 5 },
            { name: 'minecraft:respiration', lvl: 3 },
            { name: 'minecraft:aqua_affinity', lvl: 1 },
            { name: 'minecraft:unbreaking', lvl: 5 },
            { name: 'minecraft:mending', lvl: 1 },
        ],
    };
    assert.equal(itemMatchesCrusherKit(item), true);
    assert.equal(skipAhBookCrusher(item), true);
    assert.equal(isFunTimeCrusherItem(item), false);
    assert.equal(
        itemMatchesCrusherKit({
            name: 'netherite_helmet',
            enchants: [
                { name: 'minecraft:protection', lvl: 5 },
                { name: 'minecraft:unbreaking', lvl: 4 },
            ],
        }),
        false,
    );
});

test('armor mending still matches catalog but skipped for AH book', () => {
    const catalog = [
        {
            id: 'шлем-1.21',
            type: 'netherite_armor-1.21',
            name: 'netherite_helmet',
            num: 2,
            effects: [
                { name: 'minecraft:unbreaking', lvl: 4 },
                { name: 'minecraft:protection', lvl: 5 },
            ],
        },
    ];
    const withMend = {
        name: 'netherite_helmet',
        enchants: [
            { name: 'minecraft:unbreaking', lvl: 4 },
            { name: 'minecraft:protection', lvl: 5 },
            { name: 'minecraft:mending', lvl: 1 },
        ],
    };
    const cfg = findBestMatchingConfigItem(withMend, catalog);
    assert.equal(cfg?.id, 'шлем-1.21');
    assert.equal(skipAhBookArmorMending(withMend, cfg), true);
    assert.equal(
        skipAhBookArmorMending(
            { name: 'netherite_helmet', enchants: [{ name: 'minecraft:protection', lvl: 5 }] },
            cfg,
        ),
        false,
    );
});
