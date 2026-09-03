import test from 'node:test';
import assert from 'node:assert/strict';
import { isFunTimeCrusherItem, findBestMatchingConfigItem } from './slotInfo.mjs';

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

test('renamed original lore still crusher', () => {
    assert.equal(isFunTimeCrusherItem(loreOriginal()), true);
});

test('crusher does not match catalog', () => {
    const catalog = [
        {
            id: 'megasword-яд3-1.21',
            type: 'netherite_sword-1.21',
            name: 'netherite_sword',
            num: 7,
            effects: [],
        },
    ];
    assert.equal(findBestMatchingConfigItem(named('Меч крушителя'), catalog), null);
});

test('armor with mending is not catalog match', () => {
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
    const baseEnch = [
        { name: 'minecraft:unbreaking', lvl: 4 },
        { name: 'minecraft:protection', lvl: 5 },
    ];
    assert.equal(
        findBestMatchingConfigItem({ name: 'netherite_helmet', enchants: baseEnch }, catalog)?.id,
        'шлем-1.21',
    );
    assert.equal(
        findBestMatchingConfigItem(
            { name: 'netherite_helmet', enchants: [...baseEnch, { name: 'minecraft:mending', lvl: 1 }] },
            catalog,
        ),
        null,
    );
});
