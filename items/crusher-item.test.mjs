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

test('crusher custom_name skipped', () => {
    assert.equal(isFunTimeCrusherItem(named('Меч крушителя')), true);
    assert.equal(isFunTimeCrusherItem(named('Шлем крушителя')), true);
    assert.equal(isFunTimeCrusherItem(named('***psychowhore***')), false);
    assert.equal(isFunTimeCrusherItem({ name: 'netherite_sword', displayName: 'Netherite Sword' }), false);
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
