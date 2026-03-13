import fs from 'fs/promises';
import mineflayer from 'mineflayer';
import { createLogger, transports, format } from 'winston';
import { workerData, parentPort } from 'worker_threads';
import { loader as autoEat } from 'mineflayer-auto-eat'
import { writeFile, rename } from 'fs/promises';
import { join } from 'path';
import net from 'net';
import { generateKey } from 'crypto';
import protodef from 'protodef';
import zlib from 'zlib';

// ========== ГЛОБАЛЬНЫЙ ПЕРЕХВАТЧИК ВСЕХ ОШИБОК ==========
// process.on('uncaughtException', (err) => {
//     // Специально для 593716016
//     if (err.message?.includes('593716016')) {
//         console.log(`⚠️ Игнорируем ошибку с числом 593716016`);
//         return;
//     }
    
//     // Остальные проверки
//     const ignoreList = [
//         'PartialReadError',
//         'Unexpected buffer end',
//         'varint is too big',
//         'array size is abnormally large',
//         'Invalid tag',
//         'Read error for undefined',
//         'offset is out of range',
//         'Chunk size is',
//         'entity_equipment',
//         'window_items',
//         'set_slot',
//         'Missing characters in string',
//         '593913446',
//         '205876835',
//         'incorrect header check',
//         'Z_DATA_ERROR',
//         'socketClosed',
//         'read ECONNRESET'
//     ];
    
//     const shouldIgnore = ignoreList.some(msg => 
//         err.message?.includes(msg) || err.stack?.includes(msg)
//     );
    
//     if (shouldIgnore) {
//         console.log(`⚠️ Игнорируем ошибку: ${err.message?.substring(0, 100) || 'no message'}`);
//         return;
//     }
    
//     console.error('💥 Критическая ошибка:', err);
// });

// process.on('unhandledRejection', (err) => {
//     console.log(`⚠️ Игнорируем rejection: ${err?.message?.substring(0, 100) || 'no message'}`);
// });

// ========== ПАТЧ ZLIB ==========
// const originalInflate = zlib.inflate;
// const originalInflateSync = zlib.inflateSync;
// const originalUnzip = zlib.unzip;

// zlib.inflate = function(buffer, options, callback) {
//     try {
//         return originalInflate.call(this, buffer, options, callback);
//     } catch (err) {
//         console.log(`⚠️ Zlib inflate error ignored: ${err.message}`);
//         if (callback) callback(null, Buffer.alloc(0));
//     }
// };

// zlib.inflateSync = function(buffer, options) {
//     try {
//         return originalInflateSync.call(this, buffer, options);
//     } catch (err) {
//         console.log(`⚠️ Zlib inflateSync error ignored: ${err.message}`);
//         return Buffer.alloc(0);
//     }
// };

// zlib.unzip = function(buffer, options, callback) {
//     try {
//         return originalUnzip.call(this, buffer, options, callback);
//     } catch (err) {
//         console.log(`⚠️ Zlib unzip error ignored: ${err.message}`);
//         if (callback) callback(null, Buffer.alloc(0));
//     }
// };

// console.log('✅ Zlib патч добавлен');

// ========== ПАТЧ PROTODEF ==========
// try {
//     const proto = protodef;
    
//     // Патчим readVarInt
//     const originalReadVarInt = proto.readVarInt;
//     proto.readVarInt = function(buffer, offset) {
//         try {
//             if (offset < 0) offset = 0;
//             return originalReadVarInt.call(this, buffer, offset);
//         } catch (err) {
//             if (err.message.includes('Unexpected buffer end') || 
//                 err.message.includes('varint is too big')) {
//                 return { value: 0, size: 1 };
//             }
//             throw err;
//         }
//     };
    
//    // Патчим byteArray (УЛЬТРА-ЗАЩИТА)
// // ========== УЛЬТРА-ПАТЧ ДЛЯ BYTEARRAY ==========
// try {
//     const proto = protodef;
    
//     // Полностью переопределяем функцию byteArray
//     if (proto.types?.byteArray) {
//         proto.types.byteArray.read = function(buffer, offset, { count }) {
//             try {
//                 // Проверяем, не является ли count аномальным
//                 if (count === 593716016 || count === 593913446 || count > 1000000 || count < 0) {
//                     console.log(`⚠️ ByteArray: заблокировано аномальное значение ${count}`);
//                     return { value: Buffer.alloc(0), size: 1 };
//                 }
                
//                 // Проверяем выход за границы
//                 if (offset + count > buffer.length) {
//                     console.log(`⚠️ ByteArray: выход за границы буфера`);
//                     const available = buffer.length - offset;
//                     if (available > 0) {
//                         return { value: buffer.slice(offset, offset + available), size: available };
//                     }
//                     return { value: Buffer.alloc(0), size: 1 };
//                 }
                
//                 // Нормальное чтение
//                 return { value: buffer.slice(offset, offset + count), size: count };
//             } catch (err) {
//                 console.log(`⚠️ ByteArray: ошибка, возвращаем пустой буфер`);
//                 return { value: Buffer.alloc(0), size: 1 };
//             }
//         };
//         console.log('✅ ByteArray УЛЬТРА-патч');
//     }
// } catch (e) {
//     console.log('⚠️ Ошибка при патче byteArray:', e.message);
// }
    
//     // Патчим nbt
//     if (proto.types?.nbt?.read) {
//         const originalNbt = proto.types.nbt.read;
//         proto.types.nbt.read = function(buffer, offset) {
//             try {
//                 return originalNbt.call(this, buffer, offset);
//             } catch (err) {
//                 if (err.message.includes('abnormally large')) {
//                     return { value: {}, size: 0 };
//                 }
//                 throw err;
//             }
//         };
//         console.log('✅ NBT патч');
//     }
    
//     // Патчим longArray
//     if (proto.types?.longArray?.read) {
//         const originalLongArray = proto.types.longArray.read;
//         proto.types.longArray.read = function(buffer, offset, { type, endian } = {}) {
//             try {
//                 const { value: length, size: lengthSize } = this.readVarInt(buffer, offset);
                
//                 if (length > 1000000) {
//                     console.log(`⚠️ LongArray: слишком большой размер ${length}, пропускаем`);
//                     return { value: [], size: 1 };
//                 }
                
//                 offset += lengthSize;
//                 const array = [];
                
//                 for (let i = 0; i < length; i++) {
//                     const { value, size } = this.read(buffer, offset, type, { endian });
//                     array.push(value);
//                     offset += size;
//                 }
                
//                 return { value: array, size: offset - (offset - lengthSize) };
//             } catch (err) {
//                 if (err.message.includes('abnormally large')) {
//                     console.log(`⚠️ LongArray: ошибка чтения, возвращаем пустой массив`);
//                     return { value: [], size: 1 };
//                 }
//                 throw err;
//             }
//         };
//         console.log('✅ LongArray патч');
//     }
    
//     // Патчим list
//     if (proto.types?.list?.read) {
//         const originalList = proto.types.list.read;
//         proto.types.list.read = function(buffer, offset, { type }) {
//             try {
//                 const { value: typeId, size: typeSize } = this.read(buffer, offset, 'byte');
//                 offset += typeSize;
//                 const { value: length, size: lengthSize } = this.readVarInt(buffer, offset);
                
//                 if (length > 1000000) {
//                     console.log(`⚠️ List: слишком большой размер ${length}, пропускаем`);
//                     return { value: [], size: offset - typeSize };
//                 }
                
//                 offset += lengthSize;
//                 const values = [];
                
//                 for (let i = 0; i < length; i++) {
//                     const { value, size } = this.read(buffer, offset, type, { type: typeId });
//                     values.push(value);
//                     offset += size;
//                 }
                
//                 return { value: values, size: offset - (offset - typeSize - lengthSize) };
//             } catch (err) {
//                 if (err.message.includes('abnormally large')) {
//                     console.log(`⚠️ List: ошибка чтения, возвращаем пустой массив`);
//                     return { value: [], size: 1 };
//                 }
//                 throw err;
//             }
//         };
//         console.log('✅ List патч');
//     }
    
//     console.log('✅ Protodef полностью пропатчен');
// } catch (e) {
//     console.log('⚠️ Не удалось пропатчить protodef:', e.message);
// }

// ========== ОСНОВНОЙ КОД БОТА ==========
let itemPrices = workerData.itemPrices;
let itemsBuying = [];
let needReset = false;

parentPort.on('message', (data) => {
    if (data.type === 'price') {
        needReset = true;
        itemPrices = data.data;
    }
    if (data.type === 'items_buying') {
        itemsBuying = data.data;
    }
});

const minDelay = 500;
const AHDelay = 2000;
const loadingDelay = 100;

const chooseBuying = 'Выбор скупки ресурсов';
const setSectionFarmer = 'Установка секции "фермер"';
const sectionFarmer = 'Секция "фермер"';
const setSectionFood = 'Установка секции "еда"';
const sectionFood = 'Секция "еда"';
const setSectionResources = 'Установка секции "ценные ресурсы"';
const sectionResources = 'Секция "ценные ресурсы"';
const setSectionLoot = 'Установка секции "добыча"';
const sectionLoot = 'Секция "добыча"';
const analysisAH = 'Анализ аукциона';
const buy = 'Покупка';
const myItems = 'Хранилище';
const setAH = 'Установка аукциона';

const slotToChooseBuying = 13;
const slotToSetSectionFarmer = 13;
const slotToLeaveSection = 3;
const slotToSetSectionFood = 21;
const slotToSetSectionResources = 23;
const slotToSetSectionLoot = 31;
const slotToTuneAH = 52;
const slotToReloadAH = 49;
const slotToTryBuying = 0;

const ahCommand = `/ah search ${workerData.item}`;

let type = "";

const missingEnchantsNames = ["minecraft:knockback", "heavy", "unstable", "minecraft:thorns", "minecraft:binding_curse"];

const minBalance = 10000000;

const leftMouseButton = 0;
const noShift = 0;
const firstInventorySlot = 9;
const lastInventorySlot = 44;
const firstAHSlot = 0;
const lastAHSlot = 44;
const firstSellSlot = 36;

const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.colorize(),
        format.timestamp(),
        format.printf(({ timestamp, level, message }) => {
            return `${timestamp} ${level}: ${message}`;
        })
    ),
    transports: [new transports.Console()]
});

async function launchBookBuyer(name, password, anarchy) {
    
    await delay(getRandomDelayInRange(0, 10000));
    
    const bot = mineflayer.createBot({
        host: 'mc.funtime.su',
        port: 25565,
        username: name,
        password: password,
        version: '1.21.4',  // или 1.21.8
        chatLengthLimit: 256,
    });

    const loginCommand = `/l ${name}`;
    const anarchyCommand = `/an${anarchy}`;
    const shopCommand = '/shop';

    console.warn = () => {};

    bot.once('login', async () => {
        bot.loadPlugin(autoEat);
        bot.mu = false;
        bot.startTime = Date.now() - 55000;
        bot.ahFull = false;
        bot.timeReset = Date.now();
        bot.login = true;
        bot.timeActive = Date.now();
        bot.timeLogin = Date.now();
        bot.prices = [];
        bot.count = 0;
        bot.netakbistro = true;
        bot.ah = [];
        bot.needSell = false;
        bot.startClickTime = null;
        bot.updateWindow = false;
        //  bot._client.once('resource_pack_send', (packet) => {
        //     console.log('📦 Получен ресурспак, подтверждаем...');
        //     bot._client.write('resource_pack_receive', {
        //         uuid: packet.uuid || 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6',
        //         result: 3
        //     });
        // });
        setInterval(() => {
            const inv = [];
            for (let i = 0; i <= lastInventorySlot; i++) {
                const slotData = bot.inventory.slots[i];
                if (!slotData) continue;
                
                const config = findMatchingConfigItem(slotData, itemPrices);
                if (config) inv.push(config.id);
            }
            parentPort.postMessage({ name: "inventory", data: inv, username: bot.username });
        }, 10000);

        logger.info(`${name} успешно проник на сервер.`);
        await delay(5000);
        bot.chat(loginCommand);
        await delay(300)
        await delay(5000);
        bot.chat(anarchyCommand);
        // bot.acceptResourcePack()
       
        console.log('anarchy')
        await delay(8000);
        bot.chat(shopCommand);
    });

    bot.on("resourcePack", (u, h) => {
        console.log(u, h)
        if (bot._client) {
        bot._client.write('resource_pack_receive', {
            uuid: h.ascii, // UUID из кика
            result: 0 // 0 = успешно загружен
        });
        console.log('✅ Отправлено подтверждение загрузки ресурспака');
    }
    })

    bot.on('end', (reason) => {
        console.log(`⚠️ Соединение закрыто: ${reason || 'без причины'}`)
        process.exit(1);
    });

    bot.on('kicked', (reason) => {
        console.log(JSON.stringify(`kicked - ${JSON.stringify(reason)}`));
        process.exit(1);
    });

    bot.on('error', (err) => {
        console.log(err);
        process.exit(1);
    });

    bot.on('physicsTick', async () => {
        if (Date.now() - bot.timeActive > 90000) {
            bot.timeActive = Date.now();
            bot.menu = analysisAH;
            bot.mu = false;
            await safeAH(bot);
        }
    });

    bot.menu = chooseBuying;
    let slotToBuy = undefined;
    bot.startTime = Date.now() - 240000;

    bot.on('windowOpen', async () => {
        let key = "";
        switch (bot.menu) {
            case chooseBuying:
                parentPort.postMessage({ name: 'success', username: workerData.username });
                await delay(3000);
                logger.info(`${name} - ${bot.menu}`);
                bot.menu = setSectionFarmer;
                await safeClick(bot, slotToChooseBuying, minDelay);
                break;

            case setSectionFarmer:
                logger.info(`${name} - ${bot.menu}`);
                bot.menu = sectionFarmer;
                await safeClick(bot, slotToSetSectionFarmer, minDelay);
                break;

            case sectionFarmer:
                logger.info(`${name} - ${bot.menu}`);
                bot.menu = setSectionFood;
                await safeClick(bot, slotToLeaveSection, minDelay);
                break;

            case setSectionFood:
                logger.info(`${name} - ${bot.menu}`);
                bot.menu = sectionFood;
                await safeClick(bot, slotToSetSectionFood, minDelay);
                break;

            case sectionFood:
                logger.info(`${name} - ${bot.menu}`);
                bot.menu = setSectionResources;
                await safeClick(bot, slotToLeaveSection, minDelay);
                break;

            case setSectionResources:
                logger.info(`${name} - ${bot.menu}`);
                bot.menu = sectionResources;
                await delay(getRandomDelayInRange(1000, 2500));
                await safeClick(bot, slotToSetSectionResources, minDelay);
                break;

            case sectionResources:
                logger.info(`${name} - ${bot.menu}`);
                bot.menu = setSectionLoot;
                await delay(getRandomDelayInRange(1000, 2500));
                await safeClick(bot, slotToLeaveSection, minDelay);
                break;

            case setSectionLoot:
                logger.info(`${name} - ${bot.menu}`);
                bot.menu = sectionLoot;
                await delay(getRandomDelayInRange(1000, 2500));
                await safeClick(bot, slotToSetSectionLoot, minDelay);
                break;

            case sectionLoot:
                logger.info(`${name} - ${bot.menu}`);
                bot.menu = analysisAH;
                await delay(5000);
                bot.closeWindow(bot.currentWindow);
                await delay(500);
                while (Date.now() - bot.timeLogin < 13000) await delay(1000);
                await safeAH(bot);
                break;

            case analysisAH:
                logger.info(`${name} - ${bot.menu}`);
                bot.timeActive = Date.now();
                generateRandomKey(bot);
                key = bot.key;
                const resetime = Math.floor((Date.now() - bot.timeReset) / 1000);
                
                if (resetime > 60 || needReset) {
                    logger.info(`${name} - ресет`);
                    await delay(500);
                    bot.menu = myItems;
                    await safeClickBuy(bot, 46, getRandomDelayInRange(700, 1300), key);
                    break;
                }
                
                const uptime = Math.floor((Date.now() - bot.startTime) / 1000);
                if (uptime > 55 || bot.needSell) {
                    logger.info(`${name} - продажа`);
                    await sellItems(bot, itemPrices);
                    break;
                }

                let count = 0;
                for (let i = firstInventorySlot; i <= lastInventorySlot; i++) {
                    if (bot.inventory.slots[i]) count++;
                }
                
                if (count >= 36 - bot.count) {
                    logger.error('Инвентарь заполнен');
                    await sellItems(bot, itemPrices);
                    break;
                }

                logger.info(`${name} - поиск лучшего предмета`);
                let slotToBuy = await getBestAHSlot(bot, itemPrices);

                switch (slotToBuy) {
                    case null:
                        bot.menu = analysisAH;
                        await safeClickBuy(bot, slotToReloadAH, getRandomDelayInRange(1500, 4500), key);
                        break;
                    default:
                        if (bot.netakbistro) {
                            bot.netakbistro = false;
                            await safeClickBuy(bot, slotToBuy, 1655, key);
                        } else if (slotToBuy < 9) {
                            await safeClickBuy(bot, slotToBuy, getRandomDelayInRange(100, 150) * (slotToBuy + 1), key);
                        } else {
                            await safeClickBuy(bot, slotToReloadAH, getRandomDelayInRange(1500, 4500), key);
                        }
                        break;
                }
                break;

            case myItems:
                generateRandomKey(bot);
                key = bot.key;
                if (bot.currentWindow.slots[27]) {
                    logger.error('суки обновили аукцион');
                    break;
                }
                await delay(500);
                needReset = false;
                logger.info(`${name} - ${bot.menu}`);
                
                bot.count = 0;
                bot.ah = [];
                let slot = null;

                for (let i = 0; i < 8; i++) {
                    const currentSlot = bot.currentWindow?.slots[i];
                    if (!currentSlot) break;

                    const priceOnAH = await getBuyPriceInStorage(currentSlot);
                    const priceSell = await getPriceByEnchantments(currentSlot, itemPrices);

                    if (priceSell !== priceOnAH) {
                        logger.error(`chnge ${priceSell} ${priceOnAH}`);
                        bot.ahFull = false;
                        slot = i;
                        break;
                    }
                }

                if (slot !== null) {
                    bot.ahFull = false;
                    bot.needSell = true;
                    bot.menu = myItems;
                    await safeClickBuy(bot, slot, getRandomDelayInRange(700, 1300), key);
                    break;
                }

                for (let i = 0; i < 8; i++) {
                    const currentSlot = bot.currentWindow?.slots[i];
                    if (currentSlot) {
                        bot.count++;
                        const id = getIDByEnchantments(currentSlot, itemPrices);
                        bot.ah.push(id);
                    } else break;
                }

                parentPort.postMessage({ name: 'items', username: bot.username, items: bot.ah });

                if (Math.floor((Date.now() - bot.timeReset) / 1000) > 60) {
                    bot.menu = setAH;
                    await safeClickBuy(bot, 52, getRandomDelayInRange(700, 1300), key);
                } else {
                    bot.menu = analysisAH;
                    await safeClickBuy(bot, 46, getRandomDelayInRange(700, 1300), key);
                }
                break;

            case setAH:
                generateRandomKey(bot);
                key = bot.key;
                logger.info(`${name} - ${bot.menu}`);
                bot.menu = analysisAH;
                await safeClickBuy(bot, 46, getRandomDelayInRange(700, 1300), key);
                break;

            case "clan":
                logger.info(`${bot.username} ${bot.menu}`);
                generateRandomKey(bot);
                
                let countItems = countTotalItemsInWindow(bot, itemPrices);
                if (bot.ahFull && countItems === 0) {
                    const slot = findFirstMatchingSlotInInventory(bot, itemPrices);
                    if (slot) {
                        logger.info(`${bot.username} добавил`);
                        await safeClickBuy(bot, slot, 500, bot.key);
                    }
                } else if (!bot.ahFull && countItems > 0) {
                    const slot = findFirstMatchingSlotInWindow(bot, itemPrices);
                    if (slot) {
                        logger.info(`${bot.username} забрал`);
                        bot.needSell = true;
                        await safeClickBuy(bot, slot, 500, bot.key);
                    }
                }
                logger.info(`${bot.username} никуда не кликнул`);
                await delay(300);
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
                bot.startTime = Date.now();
                bot.mu = false;
                logger.info(`${bot.username} - мьютекс снят`);
                await delay(500);
                bot.menu = analysisAH;
                await safeAH(bot);
                break;
        }
    });

    bot.on('message', async (message) => {
        const messageText = message.toString();
        console.log(messageText);

        if (messageText.includes('[☃] Вы успешно купили')) {
            bot.needSell = true;
            let balanceStr = messageText;
            if (messageText.includes('.')) balanceStr = balanceStr.slice(0, -3);
            balanceStr = balanceStr.replace(/\D/g, '');
            const balance = parseInt(balanceStr);
            parentPort.postMessage({ name: 'buy', id: bot.type, price: balance });
            return;
        }

        if (messageText.includes('BotFilter >> Введите номер с картинки в чат')) {
            parentPort.postMessage(`${workerData.username} - ввести капчу`);
            return;
        }

        if (messageText.includes('вы забанены')) {
            parentPort.postMessage(`${workerData.username} - забанен`);
            return;
        }

        if (messageText.includes('[✘] Ошибка! По такой цене')) {
            console.log('[✘] Ошибка! По такой цене ', workerData.itemID);
            return;
        }

        if (messageText.includes('[✘] Ошибка! Этот товар уже Купили!')) {
            await safeClick(bot, slotToReloadAH, getRandomDelayInRange(1500, 3000));
            return;
        }

        if (messageText.includes('Сервер заполнен')) {
            bot.mu = false;
            bot.startTime = Date.now() - 240000;
            bot.ahFull = false;
            bot.timeReset = Date.now() - 60000;
            bot.login = true;
            bot.timeActive = Date.now();
            bot.timeLogin = Date.now();
            bot.prices = [];
            bot.count = 0;
            bot.netakbistro = true;
            await delay(minDelay);
            bot.chat(anarchyCommand);
            return;
        }

        if (messageText.includes('[☃] У Вас купили')) {
            bot.ahFull = false;
            let balanceStr = messageText;
            if (messageText.includes('.')) balanceStr = balanceStr.slice(0, -3);
            balanceStr = balanceStr.replace(/\D/g, '');
            const balance = parseInt(balanceStr);
            const id = getIdBySellPrice(itemPrices, balance);
            parentPort.postMessage({ name: 'sell', id: id, price: balance });
            bot.needSell = true;
            return;
        }

        if (messageText.includes('[☃]') && messageText.includes('выставлен на продажу!')) {
            if (bot.typeSell) {
                parentPort.postMessage({ name: 'try-sell', id: bot.typeSell });
            }
            bot.count++;
            return;
        }

        if (messageText.includes('Не так быстро..') ||
            messageText.includes('Данная команда недоступна в режиме AFK') ||
            messageText.includes('[☃] После входа на режим необходимо немного подождать')) {
            
            await delay(getRandomDelayInRange(500, 700));
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
            await delay(getRandomDelayInRange(500, 700));
            
            if (messageText.includes('После входа')) {
                await walk(bot);
                await delay(10000);
            } else {
                await walk(bot);
            }
            
            bot.menu = analysisAH;
            await safeAH(bot);
            return;
        }

        if (messageText.includes('[☃] Не удалось выставить') ||
            messageText.includes('[✘] Ошибка! У Вас переполнено Хранилище!')) {
            bot.ahFull = true;
            return;
        }

        if (messageText.includes('[✘] Ошибка! У Вас не хватает Монет!')) {
            await delay(getRandomDelayInRange(500, 700));
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
            await delay(getRandomDelayInRange(500, 700));
            bot.chat('/clan withdraw 3000000');
            await delay(getRandomDelayInRange(500, 700));
            bot.menu = analysisAH;
            await safeAH(bot);
            return;
        }

        if (messageText.includes('[⚠] Данной команды не существует!')) {
            bot.chat(anarchyCommand);
            await delay(11000);
            await safeAH();
            return;
        }

        if (messageText.includes('[$] Ваш баланс:')) {
            let balanceStr = messageText;
            if (messageText.includes('.')) balanceStr = balanceStr.slice(0, -3);
            balanceStr = balanceStr.replace(/\D/g, '');
            const balance = parseInt(balanceStr);
            if (isNaN(balance)) {
                logger.error('баланс NAN');
                return;
            }
            if (balance - minBalance >= 10000000) {
                await delay(500);
                bot.chat(`/clan invest ${balance - minBalance}`);
            }
            return;
        }

        if (messageText.includes('[☃] Максимальная цена')) {
            let balanceStr = messageText;
            if (messageText.includes('.')) balanceStr = balanceStr.slice(0, -3);
            balanceStr = messageText.replace(/\./g, '').replace(/\D/g, '');
            const balance = parseInt(balanceStr);
            
            const slotHotBar = bot.quickBarSlot;
            const slot = transform(slotHotBar);
            const currentPrice = getPriceByEnchantments(bot.inventory.slots[slot], itemPrices);
            const id = getIDByEnchantments(bot.inventory.slots[slot], itemPrices);
            
            const basePrice = Math.floor(balance / 10000) * 10000;
            const marker = currentPrice % 100;
            let finalPrice = basePrice + marker;
            if (finalPrice > balance) finalPrice = basePrice - 100 + marker;
            
            parentPort.postMessage({ name: "set_max_price", type: id, price: finalPrice });
            return;
        }

        if (messageText.includes('[☃] Минимальная цена')) {
            let balanceStr = messageText;
            if (messageText.includes('.')) balanceStr = balanceStr.slice(0, -3);
            balanceStr = messageText.replace(/\./g, '').replace(/\D/g, '');
            const balance = parseInt(balanceStr);
            
            const slotHotBar = bot.quickBarSlot;
            const slot = transform(slotHotBar);
            const currentPrice = getPriceByEnchantments(bot.inventory.slots[slot], itemPrices);
            const id = getIDByEnchantments(bot.inventory.slots[slot], itemPrices);
            const nacenka = getNacenkaByEnchantments(bot.inventory.slots[slot], itemPrices);
            
            const basePrice = Math.ceil(balance / 10000) * 10000;
            const marker = currentPrice % 100;
            let finalPrice = basePrice + marker + nacenka;
            
            parentPort.postMessage({ name: "set_min_price", type: id, price: finalPrice });
            return;
        }
    });
}

// ========== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ==========

function getIdBySellPrice(itemPrices, val) {
    const foundItem = itemPrices.find(item => item.priceSell % 100 === val % 100);
    return foundItem ? foundItem.id : "";
}

function countTotalItemsInWindow(bot, itemPrices) {
    if (!bot.currentWindow || !bot.currentWindow.slots) return 0;
    let totalCount = 0;
    for (let slot = 0; slot <= 45; slot++) {
        const slotData = bot.currentWindow.slots[slot];
        if (!slotData) continue;
        if (isItemMatchingConfig(slotData, itemPrices)) totalCount++;
    }
    return totalCount;
}

async function sellItems(bot, itemPrices) {
    bot.needSell = false;
    if (bot.mu) {
        await delay(500);
        await safeAH(bot);
        return;
    }
    bot.mu = true;
    await walk(bot);
    logger.info(`${bot.username} - прогулка завершена`);

    try {
        while (Date.now() - bot.timeLogin < 13000) await delay(1000);
        bot.timeActive = Date.now();
        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow);
            await delay(getRandomDelayInRange(300, 500));
        }

        while (!bot.ahFull) {
            let soldAnything = false;

            for (let quickSlot = 0; quickSlot < 9; quickSlot++) {
                if (bot.ahFull) break;
                const slotIndex = firstSellSlot + quickSlot;
                const item = bot.inventory.slots[slotIndex];
                if (!item) continue;

                const price = getBestSellPrice(bot, item, itemPrices);
                if (price > 0) {
                    if (bot.quickBarSlot !== quickSlot) {
                        await bot.setQuickBarSlot(quickSlot);
                        await delay(getRandomDelayInRange(400, 600));
                    }
                    bot.chat(`/ah sell ${price}`);
                    await delay(getRandomDelayInRange(100, 200));
                    bot.chat(`/ah sell ${price}`);
                    soldAnything = true;
                    await delay(getRandomDelayInRange(600, 800));
                } else {
                    await bot.tossStack(item);
                    await delay(getRandomDelayInRange(300, 500));
                }
            }

            if (!bot.ahFull) {
                let freeSlot = null;
                for (let i = 0; i < 9; i++) {
                    if (!bot.inventory.slots[i + firstSellSlot]) {
                        freeSlot = i;
                        break;
                    }
                }

                if (freeSlot !== null) {
                    for (let invSlot = 0; invSlot < 27; invSlot++) {
                        if (bot.ahFull) break;
                        const item = bot.inventory.slots[invSlot];
                        if (!item) continue;

                        const price = getBestSellPrice(bot, item, itemPrices);
                        if (price > 0) {
                            await bot.setQuickBarSlot(freeSlot);
                            await delay(300);
                            await bot.moveSlotItem(invSlot, firstSellSlot + freeSlot);
                            await delay(getRandomDelayInRange(500, 700));
                            bot.chat(`/ah sell ${price}`);
                            await delay(getRandomDelayInRange(100, 200));
                            bot.chat(`/ah sell ${price}`);
                            soldAnything = true;
                            await delay(getRandomDelayInRange(600, 800));
                        } else {
                            await bot.tossStack(item);
                            await delay(getRandomDelayInRange(300, 500));
                        }
                    }
                }
            }

            if (!soldAnything) break;
        }
    } catch (error) {
        logger.error(`${bot.username} - Ошибка в sellItems: ${error.stack || error}`);
    } finally {
        logger.info(`${bot.username} - продажа завершена`);
        await delay(500);
        await delay(300);

        for (let i = firstAHSlot; i < lastInventorySlot; i++) {
            const slotData = bot.inventory.slots[i];
            if (!slotData) continue;
            if (!isItemMatchingConfig(slotData, itemPrices)) {
                await bot.tossStack(slotData);
                await delay(300);
            }
        }

        bot.chat('/balance');
        await delay(500);
        await delay(300);
        bot.menu = 'clan';
        bot.chat('/clan storage');
    }
}

function transform(num) {
    if (num < 0 || num > 8) return num;
    return 44 - (8 - num);
}

function getBestSellPrice(bot, item, itemPrices) {
    return getSellPrice(item, itemPrices);
}

function getID(item, itemPrices) {
    const config = findMatchingConfigItem(item, itemPrices);
    return config ? config.id : 0;
}

function generateRandomKey(bot) {
    bot.key = Math.random().toString(36).substring(2, 15);
}

async function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

async function safeClick(bot, slot, time) {
    await delay(time);
    if (bot.currentWindow) {
        bot.timeActive = Date.now();
        await bot.clickWindow(slot, leftMouseButton, noShift);
    }
}

async function safeAH(bot) {
    if (bot.mu) return;
    bot.netakbistro = true;
    let key = bot.key;
    bot.timeActive = Date.now();
    bot.menu = analysisAH;
    bot.updateWindow = true;
    while (key === bot.key) {
        bot.chat(ahCommand);
        await delay(1000);
    }
}

async function getAHSlotsIDs(bot, itemPrices) {
    if (!bot.currentWindow?.slots) return [];
    const ids = [];
    for (let i = 0; i < 8; i++) {
        if (bot.currentWindow?.slots[i]) {
            ids.push(getID(bot.currentWindow?.slots[i]), itemPrices);
        }
    }
    return ids;
}

async function getBestAHSlot(bot, itemPrices) {
    if (!bot.currentWindow?.slots) return null;

    for (let slot = firstAHSlot; slot <= 17; slot++) {
        const slotData = bot.currentWindow.slots[slot];
        if (!slotData) continue;
        
        const currentUUID = getItemUUID(slotData);
        
        if (currentUUID && itemsBuying?.includes(currentUUID)) {
            console.log(`⏭️ Пропускаем лот ${currentUUID}, уже в очереди на покупку`);
            continue;
        }
        
        const config = findMatchingConfigItem(slotData, itemPrices, { 
            checkDurability: true,
            checkMissingEnchants: true 
        });
        
        if (!config) continue;
        
        try {
            const price = await getBuyPrice(slotData);
            console.log(`цена - ${price}`)
            if (!price || price >= config.priceSell - config.nacenka) continue;
            if (!config.priceSell) continue;

            bot.type = config.id;
            if (!bot.type) logger.error('id undefined');
            
            parentPort.postMessage({ name: 'buying', data: currentUUID });
            return slotData.slot;
        } catch (error) {
            console.error(error);
            continue;
        }
    }
    return null;
}

function getItemUUID(item) {
    try {
        const uuidArray = item?.nbt?.value?.PublicBukkitValues?.value?.['auctions:if-uuid']?.value;
        return uuidArray ? uuidArray.join(',') : null;
    } catch (e) {
        return null;
    }
}

function findFirstMatchingSlotInWindow(bot, itemPrices) {
    if (!bot.currentWindow?.slots) return null;
    for (let slot = 0; slot <= 45; slot++) {
        const slotData = bot.currentWindow.slots[slot];
        if (!slotData) continue;
        if (isItemMatchingConfig(slotData, itemPrices)) return slot;
    }
    return null;
}

function findFirstMatchingSlotInInventory(bot, itemPrices) {
    if (!bot.currentWindow?.slots) return null;
    for (let slot = 63; slot <= 89; slot++) {
        const slotData = bot.currentWindow.slots[slot];
        if (!slotData) continue;
        if (isItemMatchingConfig(slotData, itemPrices)) return slot;
    }
    return null;
}

function getPriceByEnchantments(slotData, itemPrices) {
    return getSellPrice(slotData, itemPrices);
}

function getIDByEnchantments(slotData, itemPrices) {
    return getItemId(slotData, itemPrices);
}

function getNacenkaByEnchantments(slotData, itemPrices) {
    return getItemNacenka(slotData, itemPrices);
}

function removeSlotAndTime(obj) {
    const result = JSON.parse(JSON.stringify(obj));
    delete result.slot;
    try {
        const loreEntries = result.nbt.value.display.value.Lore.value.value;
        const timeIndex = loreEntries.findIndex(entry => 
            entry.includes('Истeкaeт:') || entry.includes('Истекает:') ||
            entry.includes('expires:') || entry.includes('⟲')
        );
        if (timeIndex !== -1) loreEntries.splice(timeIndex, 1);
    } catch (error) {
        console.warn('Не удалось удалить строку со временем:', error.message);
    }
    return result;
}

function findMatchingConfigItem(item, itemPrices, options = { checkDurability: true, checkMissingEnchants: true }) {
    if (!item || !itemPrices?.length) return null;

    const filteredConfig = itemPrices.filter(config => config.id.endsWith('1.21'));
    if (filteredConfig.length === 0) return null;
    
    const sortedConfig = [...filteredConfig].sort((a, b) => b.num - a.num);
    
    const enchantments = item.nbt?.value?.Enchantments?.value?.value || [];
    const customEnchantments = item.nbt?.value?.['custom-enchantments']?.value?.value || [];

    const allEnchants = [
        ...enchantments.map(e => ({ name: e.id?.value, lvl: e.lvl?.value })),
        ...customEnchantments.map(e => ({ name: e.type?.value, lvl: e.level?.value }))
    ];

    for (const configItem of sortedConfig) {
        if (item.name !== configItem.name) continue;

        const areEnchantsValid = configItem.effects?.every(required => {
            const foundEnchant = allEnchants.find(e => e.name === required.name);
            return foundEnchant && foundEnchant.lvl >= required.lvl;
        });

        if (!areEnchantsValid) continue;

        if (options.checkMissingEnchants) {
            const hasMissingEnchants = allEnchants.some(en => {
                if (!missingEnchantsNames.includes(en.name)) return false;
                const isRequiredByConfig = configItem.effects?.some(ef => ef.name === en.name);
                return !isRequiredByConfig;
            });
            if (hasMissingEnchants) continue;
        }

        if (item.name === 'netherite_pickaxe' &&
            allEnchants.some(en => en.name === 'minecraft:silk_touch') &&
            !allEnchants.some(en => en.name === 'melting')) {
            continue;
        }

        if (options.checkDurability && item.maxDurability) {
            let coefficient = 0.9;
            if (allEnchants.some(en => en.name === 'minecraft:mending')) coefficient = 0.75;
            const damage = item.nbt?.value?.Damage?.value || 0;
            const durabilityLeft = item.maxDurability - damage;
            if (durabilityLeft < item.maxDurability * coefficient) continue;
        }

        return configItem;
    }

    return null;
}

function getSellPrice(item, itemPrices) {
    const config = findMatchingConfigItem(item, itemPrices);
    return config ? config.priceSell : 0;
}

function getItemId(item, itemPrices) {
    const config = findMatchingConfigItem(item, itemPrices);
    return config ? config.id : "";
}

function getItemNacenka(item, itemPrices) {
    const config = findMatchingConfigItem(item, itemPrices);
    return config ? config.nacenka : 0;
}

function getMinSellPrice(item, itemPrices) {
    const config = findMatchingConfigItem(item, itemPrices);
    return config ? config.minPrice : 0;
}

function isItemMatchingConfig(item, itemPrices) {
    return findMatchingConfigItem(item, itemPrices) !== null;
}

function getItemConfig(item, itemPrices) {
    return findMatchingConfigItem(item, itemPrices);
}

async function getBuyPrice(slotData) {
    const loreArray = slotData.nbt?.value?.display?.value?.Lore?.value?.value;
    if (!loreArray) return undefined;

    for (const jsonString of loreArray) {
        try {
            const parsedData = JSON.parse(jsonString);
            
            function findPrice(obj) {
                if (!obj) return null;
                if (typeof obj === 'string') {
                    const match = obj.match(/[\d,]+/);
                    return match ? match[0] : null;
                }
                if (obj.extra && Array.isArray(obj.extra)) {
                    for (const item of obj.extra) {
                        const found = findPrice(item);
                        if (found) return found;
                    }
                }
                if (obj.text && typeof obj.text === 'string') {
                    const match = obj.text.match(/[\d,]+/);
                    if (match) return match[0];
                }
                return null;
            }
            
            const priceStr = findPrice(parsedData);
            if (priceStr) {
                const price = parseInt(priceStr.replace(/,/g, ''));
                if (!isNaN(price)) return price;
            }
        } catch (e) {
            continue;
        }
    }

    logger.error('Цена не найдена');
    saveToJsonFile('error.json', slotData);
    return undefined;
}

async function getBuyPriceInStorage(slotData) {
    const loreArray = slotData?.nbt?.value?.display?.value?.Lore?.value?.value;
    if (!Array.isArray(loreArray)) return undefined;

    for (const jsonString of loreArray) {
        try {
            const parsed = JSON.parse(jsonString);

            if (parsed.text === '$' && parsed.extra?.[0]?.extra?.[0]?.extra?.[0]) {
                const priceStr = parsed.extra[0].extra[0].extra[0];
                if (typeof priceStr === 'string') {
                    const price = parseInt(priceStr.replace(/[^\d]/g, ''));
                    if (!isNaN(price)) return price;
                }
            }

            function findPriceInExtra(obj) {
                if (!obj) return null;
                if (typeof obj === 'string') {
                    const match = obj.match(/[\d,]+/);
                    return match ? match[0] : null;
                }
                if (Array.isArray(obj)) {
                    for (const item of obj) {
                        const found = findPriceInExtra(item);
                        if (found) return found;
                    }
                }
                if (obj.extra && Array.isArray(obj.extra)) {
                    for (const item of obj.extra) {
                        const found = findPriceInExtra(item);
                        if (found) return found;
                    }
                }
                if (obj.text && typeof obj.text === 'string') {
                    const match = obj.text.match(/[\d,]+/);
                    if (match) return match[0];
                }
                return null;
            }

            const priceStr = findPriceInExtra(parsed);
            if (priceStr) {
                const price = parseInt(priceStr.replace(/[^\d]/g, ''));
                if (!isNaN(price)) return price;
            }
        } catch (e) {
            continue;
        }
    }

    console.error('Цена не найдена');
    return undefined;
}

function getRandomDelayInRange(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

if (workerData) {
    launchBookBuyer(workerData.username, workerData.password, workerData.anarchy);
}

function getRandomElement(array) {
    if (!Array.isArray(array) || array.length === 0) {
        throw new Error("Input must be a non-empty array");
    }
    return array[Math.floor(Math.random() * array.length)];
}

async function longWalk(bot) {
    await delay(500);
    let timeTP = Date.now();
    bot.autoEat.enableAuto();
    bot.timeActive = Date.now();
    logger.info(`${bot.username} - все забито. Гуляем.`);
    
    while (bot.ahFull) {
        const resetime = Math.floor((Date.now() - bot.timeReset) / 1000);
        if (resetime > 60 || needReset) {
            await delay(500);
            ['forward', 'back', 'left', 'right'].forEach(move => bot.setControlState(move, false));
            await delay(500);
            await safeAH(bot);
            bot.autoEat.disableAuto();
            return;
        }

        const randomMove = ['forward', 'back', 'left', 'right'][Math.floor(Math.random() * 4)];
        bot.setControlState(randomMove, true);
        await delay(500);
        bot.setControlState(randomMove, false);
        
        if (Date.now() - timeTP > 10000) {
            await delay(500);
            timeTP = Date.now();
            const warp = getRandomElement(['mine', 'casino', 'case', 'shop']);
            bot.chat(`/warp ${warp}`);
            await delay(8000);
        }
        await delay(500);
    }

    logger.info(`${bot.username} - опять работать.`);
    ['forward', 'back', 'left', 'right'].forEach(move => bot.setControlState(move, false));
    bot.autoEat.disableAuto();
}

async function walk(bot) {
    await delay(500);
    bot.autoEat.enableAuto();
    const endTime = Date.now() + 4000;

    while (Date.now() < endTime) {
        const randomMove = ['forward', 'back', 'left', 'right'][Math.floor(Math.random() * 4)];
        bot.setControlState(randomMove, true);
        await delay(500);
        bot.setControlState(randomMove, false);
        await delay(500);
    }

    ['forward', 'back', 'left', 'right'].forEach(move => bot.setControlState(move, false));
    
    const warp = getRandomElement(['mine', 'casino', 'case', 'shop']);
    bot.chat(`/warp ${warp}`);
    await delay(8000);
    bot.autoEat.disableAuto();
}

async function safeClickBuy(bot, slot, time, key) {
    let timeDelay = time;
    if (bot.updateWindow) {
        bot.updateWindow = false;
        bot.startClickTime = Date.now();
    } else {
        timeDelay = time - (Date.now() - bot.startClickTime);
        if (timeDelay <= 0) timeDelay = 0;
    }
            
    await delay(timeDelay);
    if (bot.key != key) {
        console.log('твари ах обновили и теперь так');
        return;
    }
    if (slot === 52) bot.timeReset = Date.now();
    bot.updateWindow = true;
    if (bot.currentWindow) {
        bot.timeActive = Date.now();
        await bot.clickWindow(slot, leftMouseButton, 1);
    }
}

function normalizeItemData(obj) {
    if (!obj) return null;
    const result = JSON.parse(JSON.stringify(obj));
    delete result.slot;
    try {
        const loreEntries = result.nbt.value.display.value.Lore.value.value;
        const secondsLeft = extractTimeToSeconds(result);
        const timeIndex = loreEntries.findIndex(entry =>
            entry.includes('Истeкaeт:') || entry.includes('Истекает:') ||
            entry.includes('expires:') || entry.includes('⟲')
        );
        if (timeIndex !== -1 && secondsLeft !== null) {
            const expirationTimestamp = Date.now() + (secondsLeft * 1000);
            loreEntries[timeIndex] = `{"text":"EXP_TS:${expirationTimestamp}"}`;
        }
    } catch (error) {
        console.warn('Ошибка при нормализации времени:', error.message);
    }
    return result;
}

function extractTimeToSeconds(nbtData) {
    try {
        const loreList = nbtData?.nbt?.value?.display?.value?.Lore?.value?.value;
        if (!loreList) throw new Error('Lore не найден');

        let timeLine = "";

        for (const rawEntry of loreList) {
            try {
                const parsed = JSON.parse(rawEntry);
                let fullText = parsed.text || "";
                if (parsed.extra) fullText += parsed.extra.map(e => e.text).join("");
                if (/Ист.к.ет:/i.test(fullText)) {
                    timeLine = fullText;
                    break;
                }
            } catch (e) {
                if (/Ист.к.ет:/i.test(rawEntry)) {
                    timeLine = rawEntry;
                    break;
                }
            }
        }

        if (!timeLine) return null;

        const hMatch = timeLine.match(/(\d+)\s*ч/i);
        const mMatch = timeLine.match(/(\d+)\s*мин/i);
        const sMatch = timeLine.match(/(\d+)\s*сек/i);

        const hours = hMatch ? parseInt(hMatch[1], 10) : 0;
        const minutes = mMatch ? parseInt(mMatch[1], 10) : 0;
        const seconds = sMatch ? parseInt(sMatch[1], 10) : 0;

        const totalSeconds = (hours * 3600) + (minutes * 60) + seconds;

        if (totalSeconds === 0 && !timeLine.includes('0')) {
            throw new Error('Цифры времени не обнаружены в строке: ' + timeLine);
        }

        return totalSeconds;
    } catch (error) {
        console.error('Ошибка парсинга:', error.message);
        return null;
    }
}

async function saveToJsonFile(filePath, data) {
    const tempPath = `${filePath}.tmp`;
    try {
        const jsonString = JSON.stringify(data, null, 2);
        await writeFile(tempPath, jsonString, 'utf8');
        await rename(tempPath, filePath);
        console.log('✅ Данные успешно сохранены:', filePath);
    } catch (error) {
        console.error('❌ Ошибка при сохранении:', error);
        try { await unlink(tempPath); } catch {}
    }
}