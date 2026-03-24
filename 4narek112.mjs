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

// ========== ГЛОБАЛЬНЫЕ ПЕРЕМЕННЫЕ ==========
let itemPrices = workerData.itemPrices;
let itemsBuying = [];
let needReset = false;
let netakbistro = true
let isKrush = false
let balance = 0
let mu = false

// Глобальные переменные для состояния бота
let botStartTime = Date.now() - 55000
let botAhFull = false
let enoughItems = false
let botTimeReset = Date.now()
let botTimeActive = Date.now()
let botTimeLogin = Date.now()
let botCount = 0
let botAh = []
let botNeedSell = false
let botStartClickTime = null
let botUpdateWindow = false
let botMenu = 'Выбор скупки ресурсов'
let botKey = null
let botType = ""
let botLogin = false;
let botPrices = []
let lastWarpTP = Date.now() - 40000
let needSendAH = true

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
        version: '1.21.8',
        chatLengthLimit: 256,
    });

    const loginCommand = `/l ${name}`;
    const anarchyCommand = `/an${anarchy}`;
    const shopCommand = '/shop';

    console.warn = () => {};

    bot.once('login', async () => {
        bot.loadPlugin(autoEat);
        botStartTime = Date.now() - 55000;
        botAhFull = false;
        botTimeReset = Date.now();
        botLogin = true;
        botTimeActive = Date.now();
        botTimeLogin = Date.now();
        botPrices = [];
        botCount = 0;
        botAh = [];
        botNeedSell = false;
        botStartClickTime = null;
        botUpdateWindow = false;

        logger.info(`${name} успешно проник на сервер.`);
        await delay(1000);
        bot.chat(loginCommand);
        await delay(1000);
        bot.chat(anarchyCommand);
       
        console.log('anarchy')
        await delay(8000);
        bot.chat(shopCommand);
    });

    bot.on("resourcePack", (u, h) => {
            if (bot._client) {
                bot._client.write('resource_pack_receive', {
                    uuid: h.ascii,
                    result: 0
                });
                console.log('✅ Отправлено подтверждение загрузки ресурспака');
            } else {
                logger.error('no client')
            }
            console.log(u, h)
        // bot.acceptResourcePack()
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
        if (Date.now() - botTimeActive > 90000) {
            botTimeActive = Date.now();
            botMenu = analysisAH;
            await safeAH(bot);
        }
    });

    botMenu = chooseBuying;
    let slotToBuy = undefined;
    botStartTime = Date.now() - 240000;

    bot.on('windowOpen', async () => {
        let key = "";
        switch (botMenu) {
            case chooseBuying:
                // saveToJsonFile('777.json', bot.inventory.slots)
                parentPort.postMessage({ name: 'success', username: workerData.username });
                await delay(3000);
                logger.info(`${name} - ${botMenu}`);
                botMenu = setSectionFarmer;
                await safeClick(bot, slotToChooseBuying, minDelay);
                break;

            case setSectionFarmer:
                logger.info(`${name} - ${botMenu}`);
                botMenu = sectionFarmer;
                await safeClick(bot, slotToSetSectionFarmer, minDelay);
                break;

            case sectionFarmer:
                logger.info(`${name} - ${botMenu}`);
                botMenu = setSectionFood;
                await safeClick(bot, slotToLeaveSection, minDelay);
                break;

            case setSectionFood:
                logger.info(`${name} - ${botMenu}`);
                botMenu = sectionFood;
                await safeClick(bot, slotToSetSectionFood, minDelay);
                break;

            case sectionFood:
                logger.info(`${name} - ${botMenu}`);
                botMenu = setSectionResources;
                await safeClick(bot, slotToLeaveSection, minDelay);
                break;

            case setSectionResources:
                logger.info(`${name} - ${botMenu}`);
                botMenu = sectionResources;
                await delay(getRandomDelayInRange(1000, 2500));
                await safeClick(bot, slotToSetSectionResources, minDelay);
                break;

            case sectionResources:
                logger.info(`${name} - ${botMenu}`);
                botMenu = setSectionLoot;
                await delay(getRandomDelayInRange(1000, 2500));
                await safeClick(bot, slotToLeaveSection, minDelay);
                break;

            case setSectionLoot:
                logger.info(`${name} - ${botMenu}`);
                botMenu = sectionLoot;
                await delay(getRandomDelayInRange(1000, 2500));
                await safeClick(bot, slotToSetSectionLoot, minDelay);
                break;

            case sectionLoot:
                logger.info(`${name} - ${botMenu}`);
                botMenu = analysisAH;
                await delay(5000);
                bot.closeWindow(bot.currentWindow);
                await delay(500);
                while (Date.now() - botTimeLogin < 13000) await delay(1000);
                await safeAH(bot);
                break;

            case analysisAH:
                logger.info(`${name} - ${botMenu}`);
                botTimeActive = Date.now();
                generateRandomKey(bot);
                key = botKey;

                const uptime = Math.floor((Date.now() - botStartTime) / 1000);
                if (uptime > 55 || botNeedSell) {
                    logger.info(`${name} - продажа`);
                    await sellItems(bot, itemPrices);
                    break;
                }
                
                const resetime = Math.floor((Date.now() - botTimeReset) / 1000);
                if (resetime > 60 || needReset || enoughItems) {
                    needSendAH = true
                    logger.info(`${name} - ресет`);
                    botMenu = myItems;
                    await safeClickBuy(bot, 46, getRandomDelayInRange(500, 1000), key);
                    break;
                }

                let count = 0;
                for (let i = firstInventorySlot; i <= lastInventorySlot; i++) {
                    if (bot.inventory.slots[i]) count++;
                }
                
                if (count >= 36 - botCount) {
                    logger.error('Инвентарь заполнен');
                    await sellItems(bot, itemPrices);
                    break;
                }

                if (bot.currentWindow.slots[0] && 
                    bot.currentWindow.slots[0].name &&
                    bot.currentWindow.slots[0].name?.includes('stained_glass')) {
                    await safeClickBuy(bot, 31, getRandomDelayInRange(150, 500), key)
                    break
                }

                logger.info(`${name} - поиск лучшего предмета`);
                let slotToBuy = await getBestAHSlot(bot, itemPrices);

                switch (slotToBuy) {
                    case null:
                        botMenu = analysisAH;
                        await safeClickBuy(bot, slotToReloadAH, getRandomDelayInRange(1500, 4500), key);
                        break;
                    default:
                        if (netakbistro) {
                            netakbistro = false;
                            await safeClickBuy(bot, slotToBuy, 1655, key);
                        } else if (slotToBuy < 9) {
                            await safeClickBuy(bot, slotToBuy, getRandomDelayInRange(300, 500) * (slotToBuy + 2), key);
                        } else {
                            await safeClickBuy(bot, slotToReloadAH, getRandomDelayInRange(1500, 4500), key);
                        }
                        break;
                }
                break;

            case myItems:
                generateRandomKey(bot);
                key = botKey;
                if (bot.currentWindow.slots[27]) {
                    logger.error('суки обновили аукцион');
                    break;
                }
                if (!bot.currentWindow.slots[0]) enoughItems = false

                if (needSendAH) {
                    for (let i = 0; i < 8; i++) {
                        const currentSlot = bot.currentWindow?.slots[i];
                        if (currentSlot) {
                            botCount++;
                            const id = getIDByEnchantments(currentSlot, itemPrices);
                            botAh.push(id);
                        } else break;
                    }

                    parentPort.postMessage({ name: 'items', username: bot.username, items: botAh });
                    needSendAH = false
                    const inv = []
                    for (let i = 0; i <= lastInventorySlot; i++) {
                        const slotData = bot.inventory.slots[i];
                        if (!slotData) continue;
                        
                        const config = findMatchingConfigItem(slotData, itemPrices);
                        if (config) {
                            inv.push(config.id);
                        }
                    }
                    const msg = {name: "inventory", data: inv, username: bot.username}
                    parentPort.postMessage(msg)
                    }

                needReset = false;
                logger.info(`${name} - ${botMenu}`);
                
                botCount = 0;
                botAh = [];
                let slot = null;

                for (let i = 0; i < 19; i++) {
                    const currentSlot = bot.currentWindow?.slots[i];
                    if (!currentSlot) break;

                    const priceOnAH = getPriceFromItem(currentSlot);
                    const priceSell = await getPriceByEnchantments(currentSlot, itemPrices);

                    if (priceSell !== priceOnAH || enoughItems) {
                        logger.error(`chnge ${priceSell} ${priceOnAH}`);
                        botAhFull = false;
                        slot = i;
                        break;
                    }
                }

                if (slot !== null) {
                    botAhFull = false;
                    botNeedSell = true;
                    botMenu = myItems;
                    await safeClickBuy(bot, slot, getRandomDelayInRange(300, 600), key);
                    break;
                }

                if (Math.floor((Date.now() - botTimeReset) / 1000) > 60) {
                    botMenu = setAH;
                    await safeClickBuy(bot, 52, getRandomDelayInRange(300, 600), key);
                } else {
                    botMenu = analysisAH;
                    await safeClickBuy(bot, 46, getRandomDelayInRange(300, 600), key);
                }
                break;

            case setAH:
                generateRandomKey(bot);
                key = botKey;
                logger.info(`${name} - ${botMenu}`);
                botMenu = analysisAH;
                await safeClickBuy(bot, 46, getRandomDelayInRange(300, 600), key);
                break;

            case "clan":
                logger.info(`${bot.username} ${botMenu}`);
                generateRandomKey(bot);
                
                let countItems = countTotalItemsInWindow(bot, itemPrices);
                if (botAhFull && countItems === 0) {
                    const slot = findFirstMatchingSlotInInventory(bot, itemPrices);
                    if (slot) {
                        logger.info(`${bot.username} добавил`);
                        await safeClickBuy(bot, slot, 500, botKey);
                    }
                } else if (!botAhFull && countItems > 0) {
                    const slot = findFirstMatchingSlotInWindow(bot, itemPrices);
                    if (slot) {
                        logger.info(`${bot.username} забрал`);
                        botNeedSell = true;
                        await safeClickBuy(bot, slot, 500, botKey);
                    }
                }
                logger.info(`${bot.username} никуда не кликнул`);
                await delay(300);
                if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
                botStartTime = Date.now();
                logger.info(`${bot.username} - мьютекс снят`);
                await delay(500);
                botMenu = analysisAH;
                await safeAH(bot);
                break;
        }
    });

    bot.on('message', async (message) => {
        const messageText = message.toString();
        console.log(messageText);

        if (messageText.includes('[☃] Вы успешно купили')) {
            if (!botAhFull) botNeedSell = true;
            let balanceStr = messageText;
            balanceStr = balanceStr.replace(/\D/g, '');
            const balance = parseInt(balanceStr);
            parentPort.postMessage({ name: 'buy', id: botType, price: balance });
            return;
        }

        if (messageText.includes('BotFilter >> Введите номер с картинки в чат')) {
            parentPort.postMessage(`${workerData.username} - ввести капчу`);
            return;
        }

        if (messageText.toLowerCase().includes('вы забанены')) {
            parentPort.postMessage(`${workerData.username} - забанен`);
            return;
        }

        // if (messageText.includes('[✘] Ошибка! Этот товар уже Купили!')) {
        //     await safeClick(bot, slotToReloadAH, getRandomDelayInRange(1500, 3000));
        //     return;
        // }

        if (messageText.includes('[$] Ваш баланс:')) {
            let balanceStr = messageText;
            balanceStr = balanceStr.replace(/\D/g, '');
            const currentBalance = parseInt(balanceStr);
            if (isNaN(currentBalance)) {
                logger.error('баланс NAN');
                return;
            }
            balance = currentBalance
            return;
        }

        if (messageText.includes('Сервер заполнен')) {
            botStartTime = Date.now() - 240000;
            botAhFull = false;
            enoughItems = false
            botTimeReset = Date.now() - 60000;
            botLogin = true;
            botTimeActive = Date.now();
            botTimeLogin = Date.now();
            botPrices = [];
            botCount = 0;
            netakbistro = true;
            await delay(minDelay);
            bot.chat(anarchyCommand);
            return;
        }

        if (messageText.includes('[☃] У Вас купили')) {
            botAhFull = false;
            let balanceStr = messageText;
            botNeedSell = true;
            balanceStr = balanceStr.replace(/\D/g, '');
            const balance = parseInt(balanceStr);
            const id = getIdBySellPrice(itemPrices, balance);
            parentPort.postMessage({ name: 'sell', id: id, price: balance });
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
            
            botMenu = analysisAH;
            await safeAH(bot);
            return;
        }

        if (messageText.includes('[☃] Не удалось выставить') ||
            messageText.includes('[✘] Ошибка! У Вас переполнено Хранилище!')) {
            enoughItems = true
            botAhFull = true;
            return;
        }

        if (messageText.includes('[✘] Ошибка! У Вас не хватает Монет!')) {
            await delay(getRandomDelayInRange(500, 700));
            if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
            await delay(getRandomDelayInRange(500, 700));
            bot.chat('/clan withdraw 3000000');
            await delay(getRandomDelayInRange(500, 700));
            botMenu = analysisAH;
            await safeAH(bot);
            return;
        }

        if (messageText.includes('[⚠] Данной команды не существует!')) {
            bot.chat(anarchyCommand);
            await delay(11000);
            await safeAH(bot);
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
            if (JSON.stringify(bot.inventory.slots[slot]).includes('krush')) {
                isKrush = true
                bot.chat(`ah sell ${finalPrice}`)
                await delay(100)
                bot.chat(`ah sell ${finalPrice}`)
                isKrush = false
                return
            }
            
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
    botNeedSell = false;
    botAhFull = false
    if (bot.currentWindow) {
        bot.closeWindow(bot.currentWindow)
    }

    await walk(bot);
    logger.info(`${bot.username} - прогулка завершена`);

    try {
        while (Date.now() - botTimeLogin < 13000) {
            await delay(1000);
        }
        botTimeActive = Date.now();

        if (bot.currentWindow) {
            bot.closeWindow(bot.currentWindow);
            await delay(getRandomDelayInRange(300, 500));
        }

        while (!botAhFull) {
            let soldAnything = false;

            for (let quickSlot = 0; quickSlot < 9; quickSlot++) {
                while (isKrush) await delay(100)
                if (botAhFull) break;

                const slotIndex = firstSellSlot + quickSlot;
                const item = bot.inventory.slots[slotIndex];
                if (!item) continue;

                const price = getBestSellPrice(bot, item, itemPrices);
                if (price > 0) {
                    if (bot.quickBarSlot !== quickSlot) {
                        await delay(getRandomDelayInRange(400, 600));
                        await bot.setQuickBarSlot(quickSlot);
                    }
                    await delay(getRandomDelayInRange(400, 600));
                    bot.chat(`/ah sell ${price}`);
                    await delay(getRandomDelayInRange(200, 400));
                    bot.chat(`/ah sell ${price}`);

                    soldAnything = true;
                } else {
                    await delay(getRandomDelayInRange(300, 800));
                    await bot.tossStack(item);
                }
            }

            if (!botAhFull) {
                let freeSlot = null;
                for (let i = 0; i < 9; i++) {
                    if (!bot.inventory.slots[i + firstSellSlot]) {
                        freeSlot = i;
                        break;
                    }
                }

                if (freeSlot !== null) {
                    for (let invSlot = 0; invSlot < 27; invSlot++) {
                        while (isKrush) await delay(100)
                        if (botAhFull) break;

                        const item = bot.inventory.slots[invSlot];
                        if (!item) continue;

                        const price = getBestSellPrice(bot, item, itemPrices);
                        if (price > 0) {
                            await delay(300);
                            await bot.setQuickBarSlot(freeSlot);
                            await delay(getRandomDelayInRange(300, 500));
                            await bot.moveSlotItem(invSlot, firstSellSlot + freeSlot);

                            await delay(getRandomDelayInRange(300, 500));
                            bot.chat(`/ah sell ${price}`);
                            await delay(getRandomDelayInRange(200, 300));

                            bot.chat(`/ah sell ${price}`);

                            soldAnything = true;
                        } else {
                            await delay(getRandomDelayInRange(200, 400));
                            await bot.tossStack(item);
                        }
                    }
                }
            }

            if (!soldAnything) break;
        }
    } catch (error) {
        logger.error(`${bot.username} - Ошибка в sellItems: ${error.stack || error}`);
        parentPort.postMessage(error.stack || error)
    } finally {
        logger.info(`${bot.username} - продажа завершена`);

        await delay(300)

        for (let i = firstAHSlot; i < lastInventorySlot; i++) {
            const slotData = bot.inventory.slots[i];
            if (!slotData) continue;

            if (!isItemMatchingConfig(slotData, itemPrices)) {
                await bot.tossStack(slotData)
                await delay(300)
            }
        }

        bot.chat('/balance')
        await delay(300)
        if (balance - minBalance >= 10000000) {
            await delay(200)
            bot.chat(`/clan invest ${balance - minBalance}`)
        }

        await delay(300)
        botMenu = 'clan'
        bot.chat('/clan storage')
    }
}

function extractBalance(lines) {
    for (const line of lines) {
        const extra = line.displayName?.json?.extra;
        if (!Array.isArray(extra)) continue;

        let foundLabel = false;

        for (const part of extra) {
            const text = part?.text;
            if (typeof text !== 'string') continue;

            if (text.includes('Монет')) {
                foundLabel = true;
                continue;
            }

            if (foundLabel && /\d/.test(text)) {
                // Extract only digits and convert to number
                const cleaned = text.replace(/[^\d]/g, '');
                return cleaned ? Number(cleaned) : 0;
            }
        }
    }

    return 0;
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
    botKey = Math.random().toString(36).substring(2, 15);
}

async function delay(time) {
    return new Promise(resolve => setTimeout(resolve, time));
}

async function safeClick(bot, slot, time) {
    await delay(time);
    if (bot.currentWindow) {
        botTimeActive = Date.now();
        await bot.clickWindow(slot, leftMouseButton, noShift);
    }
}

async function safeAH(bot) {
    netakbistro = true;
    let key = botKey;
    botTimeActive = Date.now();
    botMenu = analysisAH;
    botUpdateWindow = true;
    while (key === botKey) {
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
        console.log(`uuid - ${currentUUID}`)
        
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
            const price = getPriceFromItem(slotData);
            console.log(`цена - ${price}`)
            if (!price || price >= config.priceSell - config.nacenka) continue;
            if (!config.priceSell) continue;

            botType = config.id;
            if (!botType) logger.error('id undefined');
            
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
        const customDataComp = item.components?.find(c => c.type === 'custom_data');
        if (!customDataComp) return null;

        const pubBukkit = customDataComp.data?.value?.PublicBukkitValues?.value;
        if (!pubBukkit) return null;

        const uuidArray = pubBukkit['auctions:if-uuid']?.value;
        if (!Array.isArray(uuidArray)) return null;

        return uuidArray.join(',');
    } catch (e) {
        console.log('Ошибка при получении UUID:', e.message);
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

function romanToArabic(roman) {
    const map = {
        'I': 1, 'II': 2, 'III': 3, 'IV': 4, 'V': 5,
        'VI': 6, 'VII': 7, 'VIII': 8, 'IX': 9, 'X': 10
    };
    return map[roman] || 1;
}

function extractCustomEnchantsFromItem(item) {
    const result = [];

    try {
        const customDataComp = item.components?.find(c => c.type === 'custom_data');
        const enchantsArray = customDataComp?.data?.value?.PublicBukkitValues?.value?.['minecraft:custom-enchantments']?.value?.value;
        
        if (Array.isArray(enchantsArray) && enchantsArray.length > 0) {
            
            for (const ench of enchantsArray) {
                const name = ench['minecraft:type']?.value;
                const lvl = ench['minecraft:level']?.value;
                
                if (name && typeof lvl === 'number') {
                    result.push({ name, lvl });
                }
            }
            
            return result;
        }
    } catch (e) {
    }

    
    const jsonStr = JSON.stringify(item);
    const valueRegex = /"value":"([^"]*)"/g;
    const matches = [];
    let match;
    while ((match = valueRegex.exec(jsonStr)) !== null) {
        matches.push(match[1]);
    }


    const textStrings = matches.filter(s => {
        if (!s || typeof s !== 'string') return false;
        const trimmed = s.trim();
        if (!trimmed) return false;
        if (/^#/.test(trimmed)) return false;
        return /[a-zA-Zа-яА-Я]/.test(trimmed);
    });


    const romanRegex = /^(I|II|III|IV|V|VI|VII|VIII|IX|X)$/;

    for (const str of textStrings) {
        const trimmed = str.trim();

        const lastSpaceIndex = trimmed.lastIndexOf(' ');
        if (lastSpaceIndex !== -1) {
            const possibleRoman = trimmed.substring(lastSpaceIndex + 1);
            if (romanRegex.test(possibleRoman)) {
                const name = trimmed.substring(0, lastSpaceIndex).trim();
                const lvl = romanToArabic(possibleRoman);
                result.push({ name, lvl });
                continue;
            }
        }

        result.push({ name: trimmed, lvl: 1 });
    }

    return result;
}

function getPriceFromItem(item) {
    const loreComp = item.components?.find(c => c.type === 'lore');
    if (!loreComp || !Array.isArray(loreComp.data)) {
        parentPort.postMessage(`нет лора для предмета ${item.name}: ${JSON.stringify(item)}`);
        return null;
    }

    for (const loreEntry of loreComp.data) {
        const strings = [];
        extractStrings(loreEntry, strings);

        const hasPriceMarker = strings.some(s => typeof s === 'string' && s.includes('Цен'));
        if (!hasPriceMarker) continue;

        for (const s of strings) {
            if (typeof s !== 'string') continue;
            const trimmed = s.trim();
            if (trimmed === '') continue;

            const withoutCommas = trimmed.replace(/,/g, '');
            if (/^\d*\.?\d+$/.test(withoutCommas)) {
                const num = parseFloat(withoutCommas);
                if (!isNaN(num)) {
                    if (num > 20000) {
                        return num; // нормальная цена
                    } else {
                        parentPort.postMessage(`подозрительная цена ${num} для ${item.name}: ${JSON.stringify(item)}`);
                        return null;
                    }
                }
            }
        }
    }

    // Цена не найдена ни в одной строке с маркером
    parentPort.postMessage(`не удалось извлечь цену для ${item.name} (нет подходящей строки с числом): ${JSON.stringify(item)}`);
    return null;
}

function extractStrings(node, out) {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
        for (const item of node) {
            extractStrings(item, out);
        }
    } else if (typeof node === 'object') {
        if (node.type === 'string' && node.hasOwnProperty('value')) {
            const val = node.value;
            if (typeof val === 'string') {
                out.push(val);
            } else {
                extractStrings(val, out);
            }
        } else {
            for (const val of Object.values(node)) {
                extractStrings(val, out);
            }
        }
    } else if (typeof node === 'string') {
        out.push(node);
    }
}

function findMatchingConfigItem(item, itemPrices, options = { checkDurability: true, checkMissingEnchants: true }) {
    if (!item || !itemPrices?.length) return null;

    const filteredConfig = itemPrices.filter(config => config.id.endsWith('1.21'));
    if (filteredConfig.length === 0) return null;
    
    const sortedConfig = [...filteredConfig].sort((a, b) => b.num - a.num);
    
    const numericToName = {
        32: 'minecraft:sharpness',
        10: 'minecraft:fire_aspect',
        39: 'minecraft:unbreaking',
        36: 'minecraft:sweeping',
        17: 'minecraft:knockback',
        18: 'minecraft:looting',
        27: "minecraft:protection",
        26: "minecraft:projectile_protection",
        22: "minecraft:mending",
        38: "minecraft:thorns",
        11: "minecraft:fire_protection",
        0:  "minecraft:aqua_affinity",
        30: "minecraft:respiration",
        7: "minecraft:depth_strider",
        9: "minecraft:feather_falling",
        8: "minecraft:efficiency",
        13: "minecraft:fortune",
        33: "minecraft:silk_touch",
    };

    const customNameMap = {
        'Яд': 'poison',
        'Вампиризм': 'vampirism',
        'Детекция': 'detection',
        'Тяжелый': 'heavy',
        'Нестабильный': 'unstable',
        'Магнит': 'magnet',
        'Авто-плавка': 'smelting',
        'Паутина': 'web',
        'Бульдозер': 'buldozing',
    };

    const vanillaEnchants = [];
    if (item.components && Array.isArray(item.components)) {
        const enchComponent = item.components.find(c => c && c.type === 'enchantments');
        if (enchComponent?.data?.enchantments && Array.isArray(enchComponent.data.enchantments)) {
            vanillaEnchants.push(...enchComponent.data.enchantments.map(e => {
                if (!e) return null;
                
                let name = e.id;
                if (typeof name === 'number') {
                    name = numericToName[name] || `unknown:${name}`;
                }
                
                let lvl = e.level;
                if (lvl === undefined || lvl === null) {
                    lvl = 1;
                }
                
                return { name, lvl };
            }).filter(e => e !== null));
        }
    }

    const rawCustomEnchants = extractCustomEnchantsFromItem(item);

    const customEnchants = rawCustomEnchants.map(ench => {
        const englishName = customNameMap[ench.name];
        if (englishName) {
            return { name: englishName, lvl: ench.lvl };
        } else {
            console.log(`⚠️ Неизвестное кастомное зачарование: "${ench.name}" (уровень ${ench.lvl}) — оставляем без перевода`);
            return ench;
        }
    });

    const allEnchants = [...vanillaEnchants, ...customEnchants];
    
    if (vanillaEnchants.length > 0 || customEnchants.length > 0) {
        console.log('Ванильные зачарования:', vanillaEnchants.map(e => `${e.name}:${e.lvl}`));
        console.log('Кастомные зачарования (после перевода):', customEnchants.map(e => `${e.name}:${e.lvl}`));
        console.log('Все зачарования:', allEnchants.map(e => `${e.name}:${e.lvl}`));
    }

    for (const configItem of sortedConfig) {
        if (item.name !== configItem.name) continue;

        const areEnchantsValid = configItem.effects?.every(required => {
            const foundEnchant = allEnchants.find(e => e && e.name === required.name);
            return foundEnchant && foundEnchant.lvl >= required.lvl;
        });

        if (!areEnchantsValid) continue;

        if (options.checkMissingEnchants) {
            const hasMissingEnchants = allEnchants.some(en => {
                if (!en || !missingEnchantsNames.includes(en.name)) return false;
                const isRequiredByConfig = configItem.effects?.some(ef => ef.name === en.name);
                return !isRequiredByConfig;
            });
            if (hasMissingEnchants) continue;
        }

        if (item.name === 'netherite_pickaxe' &&
            allEnchants.some(en => en && en.name === 'minecraft:silk_touch') &&
            !allEnchants.some(en => en && en.name === 'smelting')) {
            continue;
        }

        if (options.checkDurability && item.maxDurability) {
            let coefficient = 0.9;
            if (allEnchants.some(en => en && en.name === 'minecraft:mending')) coefficient = 0.85;
            const damageComp = item.components?.find(c => c.type === 'damage');
            const damage = damageComp?.data || 0;
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

function isItemMatchingConfig(item, itemPrices) {
    return findMatchingConfigItem(item, itemPrices) !== null;
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

async function walk(bot) {
    await delay(500);
    bot.autoEat.enableAuto();
    const endTime = Date.now() + 3000;

    await bot.setControlState('sneak', true)
    await delay(100)
    while (Date.now() < endTime) {
        const movements = ['forward', 'back', 'left', 'right'];
        const randomMove = movements[Math.floor(Math.random() * movements.length)];
        bot.setControlState(randomMove, true);
        await delay(500);
        bot.setControlState(randomMove, false);

        await delay(100);
    }

    ['forward', 'back', 'left', 'right', 'sneak'].forEach(async move =>
        await bot.setControlState(move, false)
    );
    if (Date.now() - lastWarpTP > 60000) {
        const warp = getRandomElement(['mine', 'casino', 'case', 'shop']);
        bot.chat(`/warp ${warp}`);
        await delay(8000);
        const endTime = Date.now() + 3000;

        await bot.setControlState('sneak', true)
        await delay(100)
        while (Date.now() < endTime) {
            const movements = ['forward', 'back', 'left', 'right'];
            const randomMove = movements[Math.floor(Math.random() * movements.length)];
            bot.setControlState(randomMove, true);
            await delay(500);
            bot.setControlState(randomMove, false);

            await delay(100);
        }
    }
    bot.autoEat.disableAuto();
}

async function safeClickBuy(bot, slot, time, key) {
    let timeDelay = time;
    if (botUpdateWindow) {
        botUpdateWindow = false;
        botStartClickTime = Date.now();
    } else {
        timeDelay = time - (Date.now() - botStartClickTime);
        if (timeDelay <= 0) timeDelay = 0;
    }
            
    await delay(timeDelay);
    if (botKey != key) {
        console.log('твари ах обновили и теперь так');
        return;
    }
    if (slot === 52) botTimeReset = Date.now();
    botUpdateWindow = true;
    if (bot.currentWindow) {
        botTimeActive = Date.now();
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
        try { await fs.unlink(tempPath); } catch {}
    }
}