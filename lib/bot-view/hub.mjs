import http from 'http';
import net from 'net';

const HOST = '127.0.0.1';
const MC_PORT = Number(process.env.VIEW_MC_PORT || 25566);
const HTTP_PORT = Number(process.env.VIEW_HTTP_PORT || 25999);

/** nick lower → { username, port, anarchy, seenAt } */
const bots = new Map();
let selected = null;

function json(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            try {
                const raw = Buffer.concat(chunks).toString('utf8');
                resolve(raw ? JSON.parse(raw) : {});
            } catch (err) {
                reject(err);
            }
        });
        req.on('error', reject);
    });
}

function listBots() {
    return [...bots.values()]
        .sort((a, b) => String(a.username).localeCompare(String(b.username)))
        .map((b) => ({
            username: b.username,
            port: b.port,
            anarchy: b.anarchy,
            selected: selected === String(b.username).toLowerCase(),
        }));
}

function findNick(arg) {
    const want = String(arg || '').trim().toLowerCase();
    if (!want) return null;
    if (bots.has(want)) return bots.get(want);
    for (const b of bots.values()) {
        if (String(b.username).toLowerCase().startsWith(want)) return b;
    }
    return null;
}

const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${HOST}`);
    try {
        if (req.method === 'GET' && url.pathname === '/bots') {
            json(res, 200, { selected, bots: listBots() });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/register') {
            const body = await readBody(req);
            const username = String(body.username || '').trim();
            const port = Number(body.port);
            if (!username || !Number.isFinite(port) || port < 1) {
                json(res, 400, { error: 'username+port' });
                return;
            }
            bots.set(username.toLowerCase(), {
                username,
                port,
                anarchy: body.anarchy ?? null,
                seenAt: Date.now(),
            });
            json(res, 200, { ok: true });
            return;
        }
        if (req.method === 'POST' && url.pathname === '/select') {
            const body = await readBody(req);
            const row = findNick(body.username);
            if (!row) {
                json(res, 404, { error: 'нет такого бота', bots: listBots() });
                return;
            }
            selected = String(row.username).toLowerCase();
            console.log(`view-hub: выбран ${row.username} → 127.0.0.1:${row.port}`);
            json(res, 200, { ok: true, username: row.username, port: row.port });
            return;
        }
        json(res, 404, { error: 'not found' });
    } catch (err) {
        json(res, 500, { error: String(err?.message || err) });
    }
});

httpServer.listen(HTTP_PORT, HOST, () => {
    console.log(`view-hub http ${HOST}:${HTTP_PORT}`);
});

const mcServer = net.createServer((sock) => {
    const row = selected ? bots.get(selected) : null;
    if (!row) {
        sock.destroy();
        return;
    }
    const up = net.connect({ host: HOST, port: row.port });
    const fail = () => {
        try { sock.destroy(); } catch { /* ignore */ }
        try { up.destroy(); } catch { /* ignore */ }
    };
    sock.on('error', fail);
    up.on('error', fail);
    sock.on('close', fail);
    up.on('close', fail);
    sock.pipe(up);
    up.pipe(sock);
});

mcServer.listen(MC_PORT, HOST, () => {
    console.log(`view-hub TLauncher ${HOST}:${MC_PORT}  (сначала POST /select)`);
});

setInterval(() => {
    const stale = Date.now() - 45000;
    for (const [k, b] of bots) {
        if (b.seenAt < stale) bots.delete(k);
    }
    if (selected && !bots.has(selected)) selected = null;
}, 10000).unref();
