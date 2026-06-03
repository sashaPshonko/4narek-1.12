/**
 * Координация покупок по UUID лота на АХ.
 * { uuid, username } — свой лот не блокирует; чужой / строка от Go — блокирует.
 */

export function normalizeBuyingEntry(entry) {
    if (entry == null) return null;
    if (typeof entry === 'string') {
        return { uuid: entry, username: null };
    }
    if (typeof entry === 'object' && entry.uuid) {
        return { uuid: String(entry.uuid), username: entry.username ?? null };
    }
    return null;
}

export function isUuidBlockedByOther(itemsBuying, uuid, myUsername) {
    if (!uuid || !Array.isArray(itemsBuying)) return false;
    for (const raw of itemsBuying) {
        const e = normalizeBuyingEntry(raw);
        if (!e || e.uuid !== uuid) continue;
        if (!e.username || e.username !== myUsername) return true;
    }
    return false;
}

export function mergeBuyingClaim(itemsBuying, claim) {
    const uuid = typeof claim === 'string' ? claim : claim?.uuid;
    const username = typeof claim === 'object' ? (claim?.username ?? null) : null;
    if (!uuid) return itemsBuying ?? [];
    const list = Array.isArray(itemsBuying) ? itemsBuying : [];
    const rest = list.filter((raw) => normalizeBuyingEntry(raw)?.uuid !== uuid);
    return [...rest, { uuid: String(uuid), username }];
}

export function uuidForGoBroadcast(claim) {
    if (typeof claim === 'string') return claim;
    return claim?.uuid ?? null;
}

/** Go шлёт только UUID — сохраняем username из локального списка. */
export function mergeGoJsonUpdate(localList, goUuids) {
    if (!Array.isArray(goUuids)) return Array.isArray(localList) ? localList : [];
    const prev = Array.isArray(localList) ? localList : [];
    const ownerByUuid = new Map();
    for (const raw of prev) {
        const e = normalizeBuyingEntry(raw);
        if (e?.uuid && e.username) ownerByUuid.set(e.uuid, e.username);
    }

    const inGo = new Set();
    const out = goUuids.map((uuid) => {
        const u = String(uuid);
        inGo.add(u);
        const owner = ownerByUuid.get(u);
        return owner ? { uuid: u, username: owner } : { uuid: u, username: null };
    });

    for (const raw of prev) {
        const e = normalizeBuyingEntry(raw);
        if (e?.uuid && e.username && !inGo.has(e.uuid)) out.push(e);
    }
    return out;
}
