/**
 * Один заход → waitForCaptcha (как у воркеров) → PNG на диск.
 * Usage: node scripts/dump-captcha.mjs [an] [username]
 * Default: 504 / depression12
 */
import { mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import mineflayer from 'mineflayer';
import { SocksClient } from 'socks';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { attachMapCache, waitForCaptcha, isCaptchaChat } from '../lib/captcha/solve-flow.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const an = String(process.argv[2] || '504');
const wantUser = process.argv[3] || 'depression12';
const OUT_DIR = join(ROOT, 'tmp');
const OUT_PNG = join(OUT_DIR, `captcha-${wantUser}-${Date.now()}.png`);

const bots = JSON.parse(readFileSync(join(ROOT, 'bots', `${an}b.json`), 'utf8'));
const ipJson = JSON.parse(readFileSync(join(ROOT, 'ip.json'), 'utf8'));
const botCfg = bots.find((b) => b.username === wantUser) || bots[0];
const proxyString = ipJson[botCfg.ip || an];
if (!proxyString) {
    console.error('нет proxy');
    process.exit(1);
}

const CONFIG_BLOCKED = new Set([
    'position', 'look', 'position_look', 'flying',
    'chat', 'chat_command', 'chat_command_signed', 'chat_message',
    'window_click', 'close_window',
    'arm_animation', 'entity_action',
    'held_item_slot', 'set_creative_slot',
]);

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function buildProxyConnect(proxyString) {
    const url = new URL(proxyString);
    const proxyHost = url.hostname;
    const proxyPort = Number(url.port);
    const proxyUsername = url.username ? decodeURIComponent(url.username) : undefined;
    const proxyPassword = url.password ? decodeURIComponent(url.password) : undefined;
    const agent = new SocksProxyAgent({
        protocol: 'socks5:',
        host: proxyHost,
        port: proxyPort,
        username: proxyUsername,
        password: proxyPassword,
    });
    const connect = (client) => {
        SocksClient.createConnection(
            {
                proxy: {
                    host: proxyHost,
                    port: proxyPort,
                    type: 5,
                    userId: proxyUsername,
                    password: proxyPassword,
                },
                command: 'connect',
                destination: { host: 'mc.funtime.su', port: 25565 },
                timeout: 20_000,
            },
            (err, info) => {
                if (err) {
                    client.emit('error', err);
                    return;
                }
                client.setSocket(info.socket);
                client.emit('connect');
            },
        );
    };
    return { agent, connect };
}

function setupConfigurationTransferFix(bot, log) {
    const client = bot._client;
    if (!client) return;
    const fallback = { name: 'minecraft:overworld', minY: -64, height: 384 };
    const ensure = () => {
        if (!Array.isArray(bot.registry.dimensionsArray) || !bot.registry.dimensionsArray.length) {
            bot.registry.dimensionsArray = Array.from({ length: 16 }, () => fallback);
            bot.registry.dimensionsByName ??= { overworld: fallback };
        }
    };
    const origLoad = bot.registry.loadDimensionCodec.bind(bot.registry);
    bot.registry.loadDimensionCodec = (codec) => {
        try {
            origLoad(codec);
        } catch {
            ensure();
        }
    };
    client.prependListener('login', ensure);
    client.prependListener('respawn', ensure);
    const PACK_ACCEPTED = 3;
    const PACK_LOADED = 0;
    let blockSelectKnownPacksWrite = false;
    const origWrite = client.write.bind(client);
    client.write = (name, params) => {
        if (client.state === 'configuration' && CONFIG_BLOCKED.has(name)) return;
        if (blockSelectKnownPacksWrite && name === 'select_known_packs') return;
        return origWrite(name, params);
    };
    client.on('start_configuration', () => {
        blockSelectKnownPacksWrite = false;
        bot.physicsEnabled = false;
        log('transfer → configuration');
    });
    client.on('finish_configuration', () => {
        blockSelectKnownPacksWrite = false;
        bot.physicsEnabled = true;
        log('transfer → configuration ok');
    });
    client.on('cookie_request', (data) => {
        if (client.state !== 'configuration') return;
        origWrite('cookie_response', { key: data.cookie });
    });
    client.prependListener('add_resource_pack', (data) => {
        if (client.state !== 'configuration') return;
        origWrite('resource_pack_receive', { uuid: data.uuid, result: PACK_ACCEPTED });
        origWrite('resource_pack_receive', { uuid: data.uuid, result: PACK_LOADED });
    });
    client.prependListener('select_known_packs', (data) => {
        if (client.state !== 'configuration') return;
        const packs = (data.packs ?? []).map((p) => ({
            namespace: p.namespace,
            id: p.id,
            version: p.version,
        }));
        blockSelectKnownPacksWrite = true;
        try {
            origWrite('select_known_packs', { packs });
        } finally {
            blockSelectKnownPacksWrite = false;
        }
    });
}

const { agent, connect } = buildProxyConnect(proxyString);
const log = (...a) => console.log(`[dump-captcha] ${a.join(' ')}`);

log(`login ${botCfg.username} an${an} → ${OUT_PNG}`);

const bot = mineflayer.createBot({
    username: botCfg.username,
    password: botCfg.password,
    host: 'mc.funtime.su',
    port: 25565,
    version: '1.21.11',
    physicsEnabled: false,
    hideErrors: true,
    logErrors: false,
    agent,
    connect,
    checkTimeoutInterval: 60_000,
});

attachMapCache(bot);
setupConfigurationTransferFix(bot, log);

let done = false;
const finish = async (label, captured) => {
    if (done) return;
    done = true;
    try {
        if (captured?.png) {
            mkdirSync(OUT_DIR, { recursive: true });
            writeFileSync(OUT_PNG, captured.png);
            log(
                `PNG ok (${label}) bytes=${captured.png.length}` +
                    ` seams=${captured.quality?.seamMean?.toFixed?.(1) ?? '?'}` +
                    ` n=${captured.frames?.length ?? '?'} → ${OUT_PNG}`,
            );
        } else {
            log(`нет PNG (${label})`);
        }
    } finally {
        try {
            bot.quit();
        } catch { /* ignore */ }
        setTimeout(() => process.exit(captured?.png ? 0 : 1), 500);
    }
};

setTimeout(() => {
    if (!done) void finish('global-timeout', null);
}, 90_000);

bot.on('login', () => log('login'));
bot.on('kicked', (r) => log('kicked', JSON.stringify(r).slice(0, 200)));
bot.on('end', () => {
    if (!done) void finish('end', null);
});
bot.on('error', (e) => log('error', e.message));

bot.once('spawn', async () => {
    log('spawn');
    try {
        bot.chat(`/l ${botCfg.password}`);
    } catch { /* ignore */ }
});

let capturing = false;
const runCapture = async (why) => {
    if (capturing || done) return;
    capturing = true;
    log(`capture start (${why})`);
    try {
        const captured = await waitForCaptcha(bot, {
            quietMs: 900,
            maxWaitMs: 25_000,
            requireFreshMaps: false,
            log,
        });
        await finish(why, captured);
    } catch (e) {
        log(`capture error: ${e.message}`);
        capturing = false;
        await finish(`error:${e.message}`, null);
    }
};

bot.on('messagestr', (msg) => {
    const text = String(msg || '');
    if (!text) return;
    if (text.includes('BotFilter') || text.includes('номер с картинки')) {
        log(`chat: ${text.slice(0, 120)}`);
    }
    if (isCaptchaChat(text)) {
        void runCapture('chat');
    }
});

// если капча уже висит без повторного чата — подождём и снимем warm
setTimeout(() => {
    if (!done && !capturing) {
        log('fallback capture без чата…');
        void runCapture('fallback');
    }
}, 15_000);
