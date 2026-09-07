/**
 * Прогулка по вейпоинтам: аккуратный поворот головы → прямая до точки → повтор.
 * Точки — walk-route.json (правка без рестарта воркера).
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
    shouldAttemptWarp as shouldAttemptWalk,
    warpCooldownMs as walkCooldownMs,
    warpStartupDelayMs as walkStartupDelayMs,
} from './warp-pick.mjs';
import {
    ensureShopFlatMap,
    generateSpreadMapRoute,
    isOnShopFlatMap,
    loadShopMap,
    loadBlockedCells,
    saveBlockedCells,
    markObstacle,
    replanLeg,
    visitKey,
} from './shop-map.mjs';
import { compileZones, NO_ZONES } from './zones.mjs';

export { shouldAttemptWalk, walkCooldownMs, walkStartupDelayMs };

const ORCH_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WALK_ROUTE_PATH = join(ORCH_ROOT, 'walk-route.json');

/** Шаг мыши vanilla 100% — как старый осмотр до короткого anti-AFK. */
const LOOK_GCD_STEP = 0.15 * (Math.PI / 180);
const LOOK_SEGMENT_PAUSE_MIN_MS = 40;
const LOOK_SEGMENT_PAUSE_MAX_MS = 160;
const TICK_MS = 50;
/** Мёртвая зона курса (~2.6°): мельче живой игрок мышь не дёргает. */
const YAW_DEADBAND_RAD = 0.046;
/** В стену не упираемся долго — «движение в блок» само по себе палево. */
const STUCK_NO_MOVE_MS = 2200;
const STUCK_NO_PROGRESS_MS = 3200;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function rndInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

function normalizeAngle(a) {
    while (a > Math.PI) a -= 2 * Math.PI;
    while (a < -Math.PI) a += 2 * Math.PI;
    return a;
}

/**
 * Единственная точка отправки поворота.
 *
 * mineflayer сам квантует Δyaw/Δpitch шагом мыши — ровно против GCD-чека
 * античита. Но при force=true он кладёт в отправляемый угол сырое значение
 * и своя защита отключается, а тик физики потом ещё и подтягивает
 * отправленный угол к entity.yaw на дробную долю шага. Поэтому шаг держим
 * целым сами и синхронизируем entity.yaw с тем, что реально ушло.
 */
async function sendLook(bot, yaw, pitch) {
    try {
        await bot.look(yaw, pitch, true);
        if (bot.entity) {
            bot.entity.yaw = yaw;
            bot.entity.pitch = pitch;
        }
    } catch {
        /* ignore */
    }
}

/** Шаг взгляда: целое число шагов мыши от текущего угла, иначе GCD ломается. */
function stepAngle(current, deltaUnits) {
    return normalizeAngle(current + deltaUnits * LOOK_GCD_STEP);
}

function xzDist(ax, az, bx, bz) {
    return Math.hypot(ax - bx, az - bz);
}

/**
 * mineflayer lookAt: atan2(-dx,-dz). Physics applyHeading uses (π − yaw) —
 * с этим yaw forward идёт к цели. Если сервер/FunAC рисует «лунную походку»,
 * walkStraightToPoint сам перевернёт yaw на π по факту смещения.
 */
function yawTo(fromX, fromZ, toX, toZ) {
    return Math.atan2(-(toX - fromX), -(toZ - fromZ));
}

/** Единичный look-вектор mineflayer (x,z) для yaw. */
function lookXZ(yaw) {
    return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}

/**
 * Случайный ломаный маршрут на плоскости вокруг origin — у каждого бота свой,
 * чтобы не топтать один и тот же loop.
 * @returns {{ x: number, y: number, z: number }[]}
 */
export function generateRandomFlatRoute(origin, {
    legsMin = 8,
    legsMax = 14,
    legLenMin = 10,
    legLenMax = 24,
    radiusMax = 48,
    rng = Math.random,
} = {}) {
    const ox = Number(origin.x) || 0;
    const oy = Number(origin.y) || 90;
    const oz = Number(origin.z) || 0;
    const n = rndInt(legsMin, legsMax);
    const pts = [{ x: ox, y: oy, z: oz }];
    let x = ox;
    let z = oz;
    // heading: угол в плоскости XZ, куда идём (0 = −Z / север mineflayer)
    let heading = rng() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
        // плавный поворот — без разворотов на месте
        heading = normalizeAngle(heading + (rng() - 0.5) * Math.PI * 0.85);
        const len = legLenMin + rng() * (legLenMax - legLenMin);
        let nx = x + (-Math.sin(heading)) * len;
        let nz = z + (-Math.cos(heading)) * len;
        const dx = nx - ox;
        const dz = nz - oz;
        const d = Math.hypot(dx, dz);
        if (d > radiusMax) {
            const s = radiusMax / d;
            nx = ox + dx * s;
            nz = oz + dz * s;
            heading = normalizeAngle(heading + Math.PI * (0.45 + rng() * 0.35));
        }
        pts.push({ x: nx, y: oy, z: nz });
        x = nx;
        z = nz;
    }
    return pts;
}

/**
 * @param {unknown} raw
 * @returns {{ x: number, y: number, z: number }[]}
 */
export function parseRoutePoints(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const p of raw) {
        if (!p || typeof p !== 'object') continue;
        const x = Number(p.x);
        const y = Number(p.y);
        const z = Number(p.z);
        if (![x, y, z].every(Number.isFinite)) continue;
        out.push({ x, y, z });
    }
    return out;
}

function parseSpawnPoint(raw, fallback) {
    if (!raw || typeof raw !== 'object') return { ...fallback };
    const x = Number(raw.x);
    const y = Number(raw.y);
    const z = Number(raw.z);
    if (![x, y, z].every(Number.isFinite)) return { ...fallback };
    return { x, y, z };
}

/** Длина замкнутого/разомкнутого пути по XZ. */
export function routeTotalLength(points, loop = true) {
    if (!points?.length || points.length < 2) return 0;
    const edges = loop ? points.length : points.length - 1;
    let total = 0;
    for (let i = 0; i < edges; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        total += xzDist(a.x, a.z, b.x, b.z);
    }
    return total;
}

/**
 * Точка на дуге s метров от points[fromIdx] вдоль маршрута.
 * @returns {{ x: number, y: number, z: number, endIdx: number, traveled: number } | null}
 */
export function pointAlongRoute(points, fromIdx, s, loop = true) {
    if (!points?.length || points.length < 2 || !(s > 0)) return null;
    const n = points.length;
    let left = s;
    let i = fromIdx;
    const maxHops = loop ? n : n - 1;
    for (let hop = 0; hop < maxHops; hop++) {
        const a = points[i];
        const j = (i + 1) % n;
        if (!loop && j === 0) break;
        const b = points[j];
        const len = xzDist(a.x, a.z, b.x, b.z);
        if (len < 1e-6) {
            i = j;
            continue;
        }
        if (left <= len) {
            const t = left / len;
            return {
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
                z: a.z + (b.z - a.z) * t,
                endIdx: j,
                traveled: s,
            };
        }
        left -= len;
        i = j;
    }
    const last = points[i];
    return { x: last.x, y: last.y, z: last.z, endIdx: i, traveled: s - left };
}

/** Читает JSON каждый вызов — правки точек без рестарта воркера. */
export function loadWalkRoute(filePath = WALK_ROUTE_PATH) {
    const fallback = {
        loop: true,
        arriveXZ: 1.25,
        maxMs: 180_000,
        stopFracMin: 0.25,
        stopFracMax: 0.5,
        lookAlignRad: 0.09,
        lookMaxMs: 5500,
        preWalkChat: null,
        /** Как после /warp: waitWarpTeleport ≈ 7.5s */
        preWalkChatWaitMs: 7500,
        /** /spawn при stuck или если уже в ловушке z≈21 */
        spawnOnStuck: true,
        spawnWaitMs: 7500,
        /** Куда тп /spawn (стартовая точка маршрута) */
        spawnPoint: { x: 0, y: 90, z: 0 },
        /**
         * mode:
         * - "fixed" — points из файла (старый spawn-loop)
         * - "random" — слепой random без карты (legacy)
         * - "shop_map" — /warp shop + scan плоскости + A* развод
         */
        mode: 'fixed',
        random: {
            legsMin: 8,
            legsMax: 14,
            legLenMin: 10,
            legLenMax: 24,
            radiusMax: 48,
        },
        map: {
            radiusXZ: 110,
            minFlatCells: 250,
            maxAgeMs: 12 * 60 * 60 * 1000,
            legsMin: 8,
            legsMax: 14,
            goalDistMin: 30,
            goalDistMax: 110,
            /** Только если бот НЕ на плоскости — стартовый /warp */
            entryWarp: '/warp portal',
            entryWarpWaitMs: 8000,
            onMapMaxDist: 5,
            /** Маршрут живёт между циклами: за цикл проходим кусок */
            sessionMaxMs: 45 * 60 * 1000,
            cycleDistMin: 60,
            cycleDistMax: 150,
            /** Сколько раз за цикл пробуем обойти препятствие */
            replanMax: 4,
            /** Ушёл дальше от прежних сканов — досканируем и расширим карту */
            rescanDist: 55,
            maxCells: 160_000,
            /** Тяга в неисхоженное при выборе цели */
            freshBonus: 30,
        },
        /**
         * Куда нельзя. Оси внутри записи — по И, записи — по ИЛИ.
         * Формат: ">105", "<-40", "20..90", "105" или { min, max }.
         */
        forbiddenZones: [],
        /** Отступ от границы зоны, блоков */
        zoneMargin: 2,
        /** Не тащить на /spawn перед прогулкой (для /warp shop) */
        skipSpawnHome: false,
        points: [],
    };
    if (!existsSync(filePath)) {
        return { ...fallback, filePath, missing: true };
    }
    try {
        const j = JSON.parse(readFileSync(filePath, 'utf8'));
        const points = parseRoutePoints(j.points);
        let stopFracMin = Number(j.stopFracMin);
        let stopFracMax = Number(j.stopFracMax);
        if (!Number.isFinite(stopFracMin)) stopFracMin = fallback.stopFracMin;
        if (!Number.isFinite(stopFracMax)) stopFracMax = fallback.stopFracMax;
        stopFracMin = Math.max(0.05, Math.min(0.95, stopFracMin));
        stopFracMax = Math.max(stopFracMin, Math.min(1, stopFracMax));
        const preRaw = j.preWalkChat;
        const preWalkChat =
            typeof preRaw === 'string' && preRaw.trim() ? preRaw.trim() : null;
        return {
            loop: j.loop !== false,
            arriveXZ: Math.max(0.6, Number(j.arriveXZ) || fallback.arriveXZ),
            maxMs: Math.max(20_000, Number(j.maxMs) || fallback.maxMs),
            stopFracMin,
            stopFracMax,
            lookAlignRad: Math.max(0.03, Number(j.lookAlignRad) || fallback.lookAlignRad),
            lookMaxMs: Math.max(1500, Number(j.lookMaxMs) || fallback.lookMaxMs),
            preWalkChat,
            preWalkChatWaitMs: Math.max(
                500,
                Number(j.preWalkChatWaitMs) || fallback.preWalkChatWaitMs,
            ),
            spawnOnStuck: j.spawnOnStuck !== false,
            spawnWaitMs: Math.max(800, Number(j.spawnWaitMs) || fallback.spawnWaitMs),
            spawnPoint: parseSpawnPoint(j.spawnPoint, fallback.spawnPoint),
            mode: j.mode === 'shop_map' || j.mode === 'random' ? j.mode : 'fixed',
            skipSpawnHome: j.skipSpawnHome === true
                || (typeof preWalkChat === 'string' && /\/warp\s+/i.test(preWalkChat)),
            random: {
                legsMin: Math.max(3, Number(j.random?.legsMin) || fallback.random.legsMin),
                legsMax: Math.max(3, Number(j.random?.legsMax) || fallback.random.legsMax),
                legLenMin: Math.max(3, Number(j.random?.legLenMin) || fallback.random.legLenMin),
                legLenMax: Math.max(4, Number(j.random?.legLenMax) || fallback.random.legLenMax),
                radiusMax: Math.max(10, Number(j.random?.radiusMax) || fallback.random.radiusMax),
            },
            map: {
                radiusXZ: Math.max(24, Number(j.map?.radiusXZ) || fallback.map.radiusXZ),
                minFlatCells: Math.max(50, Number(j.map?.minFlatCells) || fallback.map.minFlatCells),
                maxAgeMs: Math.max(
                    60_000,
                    Number(j.map?.maxAgeMs) || fallback.map.maxAgeMs,
                ),
                legsMin: Math.max(2, Number(j.map?.legsMin) || fallback.map.legsMin),
                legsMax: Math.max(2, Number(j.map?.legsMax) || fallback.map.legsMax),
                goalDistMin: Math.max(6, Number(j.map?.goalDistMin) || fallback.map.goalDistMin),
                goalDistMax: Math.max(8, Number(j.map?.goalDistMax) || fallback.map.goalDistMax),
                entryWarp: (typeof j.map?.entryWarp === 'string' && j.map.entryWarp.trim())
                    ? j.map.entryWarp.trim()
                    : (fallback.map.entryWarp || null),
                entryWarpWaitMs: Math.max(
                    500,
                    Number(j.map?.entryWarpWaitMs) || fallback.map.entryWarpWaitMs,
                ),
                onMapMaxDist: Math.max(
                    2,
                    Number(j.map?.onMapMaxDist) || fallback.map.onMapMaxDist,
                ),
                sessionMaxMs: Math.max(
                    60_000,
                    Number(j.map?.sessionMaxMs) || fallback.map.sessionMaxMs,
                ),
                cycleDistMin: Math.max(10, Number(j.map?.cycleDistMin) || fallback.map.cycleDistMin),
                cycleDistMax: Math.max(15, Number(j.map?.cycleDistMax) || fallback.map.cycleDistMax),
                replanMax: Math.max(
                    0,
                    Number.isFinite(Number(j.map?.replanMax))
                        ? Number(j.map.replanMax)
                        : fallback.map.replanMax,
                ),
                rescanDist: Math.max(16, Number(j.map?.rescanDist) || fallback.map.rescanDist),
                maxCells: Math.max(5000, Number(j.map?.maxCells) || fallback.map.maxCells),
                freshBonus: Number.isFinite(Number(j.map?.freshBonus))
                    ? Math.max(0, Number(j.map.freshBonus))
                    : fallback.map.freshBonus,
            },
            forbiddenZones: Array.isArray(j.forbiddenZones) ? j.forbiddenZones : [],
            zoneMargin: Number.isFinite(Number(j.zoneMargin))
                ? Math.max(0, Number(j.zoneMargin))
                : fallback.zoneMargin,
            points,
            filePath,
            missing: false,
        };
    } catch (err) {
        return { ...fallback, filePath, missing: true, error: String(err?.message || err) };
    }
}

function clearMoveControls(bot) {
    if (!bot?.setControlState) return;
    for (const key of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) {
        try {
            bot.setControlState(key, false);
        } catch {
            /* ignore */
        }
    }
    try {
        bot.refreshPlayerInput?.();
    } catch {
        /* ignore */
    }
}

/**
 * Индекс ближайшей точки; если уже «на» ней — стартуем с неё (идём к следующей).
 */
export function nearestPointIndex(points, x, z, arriveXZ) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
        const d = xzDist(x, z, points[i].x, points[i].z);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    return { index: best, dist: bestD, onPoint: bestD <= arriveXZ };
}

/**
 * Аккуратный поворот головы к цели (GCD-шаги, как старый осмотр), без WASD.
 * Держим свой yaw — entity.yaw на FT отстаёт.
 */
export async function lookTowardPoint(bot, target, {
    shouldAbort = null,
    alignRad = 0.09,
    maxMs = 5500,
    log = null,
} = {}) {
    if (!bot?.entity) return 'gone';

    const deadline = Date.now() + maxMs;
    let yaw = bot.entity.yaw;
    let pitch = bot.entity.pitch;
    const startYaw = yaw;

    while (Date.now() < deadline) {
        if (typeof shouldAbort === 'function' && shouldAbort()) return 'abort';
        if (!bot?.entity) return 'gone';

        const want = yawTo(bot.entity.position.x, bot.entity.position.z, target.x, target.z);
        let err = normalizeAngle(want - yaw);
        if (Math.abs(err) <= alignRad) {
            await sendLook(bot, yaw, pitch);
            const turned = Math.abs(normalizeAngle(yaw - startYaw)) * (180 / Math.PI);
            log?.(
                `walk → look ok Δyaw~${turned.toFixed(0)}° → (${target.x}, ${target.z})`,
            );
            return 'ok';
        }

        // Темп: медленно / обычно / чуть быстрее. Шаг = один тик = один пакет,
        // поэтому units задаёт скорость поворота (45 units ≈ 135°/с — предел
        // живой руки; без разбиения по тикам весь сегмент улетал одним рывком).
        const pace = Math.random();
        let yawUnitsMin;
        let yawUnitsMax;
        let steps;
        if (pace < 0.3) {
            yawUnitsMin = 8;
            yawUnitsMax = 18;
            steps = rndInt(6, 14);
        } else if (pace < 0.8) {
            yawUnitsMin = 14;
            yawUnitsMax = 30;
            steps = rndInt(5, 12);
        } else {
            yawUnitsMin = 22;
            yawUnitsMax = 45;
            steps = rndInt(4, 9);
        }

        const dir = err >= 0 ? 1 : -1;
        for (let i = 0; i < steps; i++) {
            if (Date.now() >= deadline) break;
            if (typeof shouldAbort === 'function' && shouldAbort()) return 'abort';
            if (!bot?.entity) return 'gone';

            const remain = normalizeAngle(
                yawTo(bot.entity.position.x, bot.entity.position.z, target.x, target.z) - yaw,
            );
            if (Math.abs(remain) <= alignRad) break;

            // добор целого числа шагов мыши: остаток не «доводим» дробью
            const remainUnits = Math.floor(Math.abs(remain) / LOOK_GCD_STEP);
            if (remainUnits < 1) break;
            const units = Math.min(rndInt(yawUnitsMin, yawUnitsMax), remainUnits);
            yaw = stepAngle(yaw, dir * units);

            if (Math.random() < 0.22) {
                const sign = Math.random() < 0.5 ? -1 : 1;
                const next = stepAngle(pitch, sign * rndInt(1, 3));
                // за границу не выходим шагом «до упора» — просто не шагаем
                if (next >= -0.35 && next <= 0.12) pitch = next;
            }

            await sendLook(bot, yaw, pitch);
            await sleep(TICK_MS);
        }

        if (Math.random() < 0.8) {
            await sleep(rndInt(LOOK_SEGMENT_PAUSE_MIN_MS, LOOK_SEGMENT_PAUSE_MAX_MS));
        }
    }

    log?.(`walk → look timeout → (${target.x}, ${target.z})`);
    return 'timeout';
}

/**
 * Прямая до точки: только forward (+sprint на длинных), лёгкая подстройка yaw.
 * Сход с коридора / падение по y → offtrack (не крутить 20 stuck-ног).
 */
async function walkStraightToPoint(bot, target, {
    arriveXZ,
    shouldAbort,
    deadline,
    log,
    clientYaw,
    zones = NO_ZONES,
}) {
    const start = bot.entity?.position;
    if (!start) {
        clearMoveControls(bot);
        return { status: 'gone', yaw: 0 };
    }
    const ax = start.x;
    const ay = start.y;
    const az = start.z;

    let lastX = ax;
    let lastZ = az;
    let lastMoveAt = Date.now();
    let lastProgressAt = Date.now();
    let bestDist = xzDist(ax, az, target.x, target.z);
    let lastLogAt = 0;
    // продолжаем ровно с того угла, что уже ушёл на сервер после поворота:
    // подмена на «идеальный» yawTo дала бы дельту не по решётке мыши
    let yaw = bot.entity?.yaw ?? clientYaw ?? yawTo(ax, az, target.x, target.z);
    let pitch = bot.entity?.pitch ?? -0.16;
    let moonwalkChecked = false;
    const walkStartedAt = Date.now();
    const moonFromX = ax;
    const moonFromZ = az;
    // спринт с гистерезисом: без него entity_action дребезжит на границе
    let sprinting = false;
    // взгляд правим редко и целыми шагами мыши, как живой игрок на прямой
    let nextPitchAt = Date.now() + rndInt(1200, 4000);

    while (Date.now() < deadline) {
        if (typeof shouldAbort === 'function' && shouldAbort()) {
            clearMoveControls(bot);
            return { status: 'abort', yaw };
        }
        if (!bot?.entity) {
            clearMoveControls(bot);
            return { status: 'gone', yaw };
        }

        const { x, y, z } = bot.entity.position;
        const dist = xzDist(x, z, target.x, target.z);
        if (dist <= arriveXZ) {
            clearMoveControls(bot);
            return { status: 'ok', yaw };
        }

        // страховка поверх карты: клеток зоны в графе нет, но прямая между
        // вейпоинтами могла срезать угол — тогда тормозим прямо на ходу
        const zone = zones?.blocks?.(bot.entity.position);
        if (zone) {
            clearMoveControls(bot);
            log?.(
                `walk → стоп: зона «${zone}» ~(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`,
            );
            return { status: 'zone', yaw };
        }

        // упали / унесло с прямой start→target
        const off = perpDistToSegment(x, z, ax, az, target.x, target.z);
        if (off > 5.5 || y < ay - 2.8) {
            clearMoveControls(bot);
            log?.(
                `walk → offtrack ~(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`
                + ` off=${off.toFixed(1)} Δy=${(y - ay).toFixed(1)} → (${target.x}, ${target.z})`,
            );
            return { status: 'offtrack', yaw };
        }

        // идём «затылком» вперёд — это баг, а не то, что чинят рывком на 180°:
        // мгновенный разворот сам по себе выглядит как чит. Просто выходим.
        if (!moonwalkChecked && Date.now() - walkStartedAt > 400) {
            const mx = x - moonFromX;
            const mz = z - moonFromZ;
            const mlen = Math.hypot(mx, mz);
            if (mlen > 0.7) {
                const look = lookXZ(yaw);
                const dot = (mx / mlen) * look.x + (mz / mlen) * look.z;
                if (dot < -0.2) {
                    clearMoveControls(bot);
                    log?.(`walk → идём спиной вперёд (dot=${dot.toFixed(2)}) — стоп`);
                    return { status: 'offtrack', yaw };
                }
                moonwalkChecked = true;
            }
        }

        const moved = xzDist(x, z, lastX, lastZ);
        if (moved > 0.08) {
            lastX = x;
            lastZ = z;
            lastMoveAt = Date.now();
        } else if (Date.now() - lastMoveAt > STUCK_NO_MOVE_MS) {
            clearMoveControls(bot);
            log?.(
                `walk → stuck ~(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`
                + ` → (${target.x}, ${target.z})`,
            );
            return { status: 'stuck', yaw };
        }

        if (dist < bestDist - 0.15) {
            bestDist = dist;
            lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt > STUCK_NO_PROGRESS_MS) {
            clearMoveControls(bot);
            log?.(
                `walk → no_progress ~(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`
                + ` d=${dist.toFixed(1)} → (${target.x}, ${target.z})`,
            );
            return { status: 'stuck', yaw };
        }

        if (Date.now() - lastLogAt > 2000) {
            lastLogAt = Date.now();
            log?.(
                `walk → go ~(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`
                + ` d=${dist.toFixed(1)} off=${off.toFixed(1)}`,
            );
        }

        // На прямой живой игрок мышь не трогает: правим курс только когда
        // реально увело, целыми шагами GCD, и молчим в остальные тики.
        let turned = false;
        const err = normalizeAngle(yawTo(x, z, target.x, target.z) - yaw);
        if (Math.abs(err) > YAW_DEADBAND_RAD) {
            const maxUnits = Math.floor(Math.abs(err) / LOOK_GCD_STEP);
            const units = Math.min(maxUnits, rndInt(2, 6));
            if (units >= 1) {
                yaw = stepAngle(yaw, Math.sign(err) * units);
                turned = true;
            }
        }
        if (Date.now() >= nextPitchAt) {
            nextPitchAt = Date.now() + rndInt(1200, 4000);
            const sign = Math.random() < 0.5 ? -1 : 1;
            const next = stepAngle(pitch, sign * rndInt(1, 3));
            if (next >= -0.35 && next <= 0.05) {
                pitch = next;
                turned = true;
            }
        }
        if (turned) await sendLook(bot, yaw, pitch);

        if (dist > 9) sprinting = true;
        else if (dist < 6) sprinting = false;
        try {
            bot.setControlState('forward', true);
            bot.setControlState('back', false);
            bot.setControlState('sprint', sprinting);
            bot.refreshPlayerInput?.();
        } catch {
            /* ignore */
        }

        await sleep(TICK_MS);
    }

    clearMoveControls(bot);
    return { status: 'timeout', yaw };
}

function perpDistToSegment(px, pz, ax, az, bx, bz) {
    const dx = bx - ax;
    const dz = bz - az;
    const len2 = dx * dx + dz * dz;
    if (len2 < 1e-6) return Math.hypot(px - ax, pz - az);
    let t = ((px - ax) * dx + (pz - az) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), pz - (az + t * dz));
}

/**
 * Дробим длинные прямые — меньше шансов улететь в яму между вершинами loop.
 */
function densifyChain(start, targets, step = 5.5) {
    if (!targets?.length) return [];
    const out = [];
    let cur = { x: start.x, y: start.y, z: start.z };
    for (const t of targets) {
        const d = xzDist(cur.x, cur.z, t.x, t.z);
        if (d <= step + 0.4) {
            out.push(t);
        } else {
            const n = Math.ceil(d / step);
            for (let i = 1; i <= n; i++) {
                const u = i / n;
                out.push({
                    x: cur.x + (t.x - cur.x) * u,
                    y: cur.y + (t.y - cur.y) * u,
                    z: cur.z + (t.z - cur.z) * u,
                });
            }
        }
        cur = t;
    }
    return out;
}

/**
 * Одна нога: look → прямая.
 */
async function walkOneLeg(bot, target, opts) {
    // цель внутри запретной зоны — туда не идём вовсе
    const zoneAhead = opts.zones?.blocks?.(target);
    if (zoneAhead) {
        opts.log?.(
            `walk → цель (${target.x.toFixed(1)}, ${target.z.toFixed(1)}) в зоне «${zoneAhead}» — пропуск`,
        );
        return 'zone';
    }

    const look = await lookTowardPoint(bot, target, {
        shouldAbort: opts.shouldAbort,
        alignRad: opts.lookAlignRad,
        maxMs: opts.lookMaxMs,
        log: opts.log,
    });
    if (look !== 'ok') return look;

    // пауза после поворота — look-пакеты успевают дойти до сервера
    await sleep(rndInt(280, 480));
    if (typeof opts.shouldAbort === 'function' && opts.shouldAbort()) return 'abort';

    // без «доводки» на идеальный yawTo: это дельта не по решётке мыши.
    // Курс уже выставлен поворотом, остальное доберёт сама ходьба.
    const res = await walkStraightToPoint(bot, target, {
        arriveXZ: opts.arriveXZ,
        shouldAbort: opts.shouldAbort,
        deadline: opts.deadline,
        log: opts.log,
        zones: opts.zones,
    });
    return res.status;
}

/**
 * Цепочка целей: вершины до стопа + финальная точка на 25–50% дуги.
 * @returns {{ x: number, y: number, z: number }[]}
 */
function buildLegTargets(points, fromIdx, stop, loop) {
    const targets = [];
    const n = points.length;
    let i = fromIdx;
    const maxHops = loop ? n + 1 : n;
    for (let hop = 0; hop < maxHops; hop++) {
        const j = (i + 1) % n;
        if (!loop && j === 0 && i === n - 1) break;
        const next = points[j];
        const stopOnThisEdge =
            stop.endIdx === j
            && xzDist(stop.x, stop.z, next.x, next.z) > 0.35;
        if (stopOnThisEdge) {
            targets.push({ x: stop.x, y: stop.y, z: stop.z });
            break;
        }
        targets.push(next);
        i = j;
        if (j === stop.endIdx && xzDist(stop.x, stop.z, next.x, next.z) <= 0.35) {
            break;
        }
        // стоп почти на вершине j
        if (
            stop.endIdx === j
            && xzDist(stop.x, stop.z, next.x, next.z) <= 0.35
        ) {
            break;
        }
    }
    if (!targets.length) {
        targets.push({ x: stop.x, y: stop.y, z: stop.z });
    }
    return targets;
}

/**
 * Ловушка у невидимого барьера плазы an502 (z≈21, высокая y).
 */
export function isPlazaBarrierTrap(pos) {
    if (!pos) return false;
    const z = Number(pos.z);
    const y = Number(pos.y);
    if (![z, y].every(Number.isFinite)) return false;
    return z >= 19.5 && z <= 23.5 && y >= 87;
}

async function tryJumpUnstick(bot, log = null) {
    if (!bot?.setControlState) return;
    log?.('walk → jump unstick');
    try {
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        bot.refreshPlayerInput?.();
        await sleep(450);
        bot.setControlState('jump', false);
        bot.refreshPlayerInput?.();
        await sleep(200);
    } catch {
        /* ignore */
    }
    clearMoveControls(bot);
}

async function chatSpawnRecover(bot, {
    shouldAbort = null,
    waitMs = 7500,
    spawnPoint = { x: 0, y: 90, z: 0 },
    log = null,
    reason = 'stuck',
} = {}) {
    clearMoveControls(bot);
    log?.(`walk → /spawn (${reason}), жду ~${waitMs}ms как после warp`);
    try {
        bot.chat('/spawn');
    } catch {
        /* ignore */
    }
    // Как waitWarpTeleport: тп не мгновенный. Потом проверяем, что реально ушли к спавну.
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        if (typeof shouldAbort === 'function' && shouldAbort()) return 'abort';
        if (!bot?.entity) return 'gone';
        await sleep(200);
    }
    if (typeof shouldAbort === 'function' && shouldAbort()) return 'abort';
    if (!bot?.entity) return 'gone';

    // доп. окно: иногда тп чуть позже 7.5с
    const softDeadline = Date.now() + 4000;
    while (Date.now() < softDeadline) {
        if (typeof shouldAbort === 'function' && shouldAbort()) return 'abort';
        if (!bot?.entity) return 'gone';
        const p = bot.entity.position;
        if (xzDist(p.x, p.z, spawnPoint.x, spawnPoint.z) <= 4) break;
        await sleep(200);
    }

    const p = bot.entity.position;
    const d = xzDist(p.x, p.z, spawnPoint.x, spawnPoint.z);
    log?.(
        `walk → после spawn ~(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`
        + ` Δxz=${d.toFixed(1)} от (${spawnPoint.x},${spawnPoint.z})`,
    );
    if (d > 6 || isPlazaBarrierTrap(p)) {
        log?.('walk → spawn не доехал (всё ещё далеко/барьер)');
        return 'failed';
    }
    return 'ok';
}

/**
 * План на весь запуск воркера: username → остаток маршрута.
 * Каждый anti-AFK цикл проходим кусок, а не телепортируемся заново.
 */
const shopSessions = new Map();

async function sleepAbortable(ms, bot, shouldAbort) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (typeof shouldAbort === 'function' && shouldAbort()) return 'abort';
        if (!bot?.entity) return 'gone';
        await sleep(200);
    }
    return null;
}

/**
 * Прогулка по территории shop: маршрут строится один раз на запуск,
 * за цикл проходим его кусок, при затыке — обходим препятствие через A*.
 */
async function walkShopMapSession(bot, route, { shouldAbort, log: logFn, rng, username, zones }) {
    const cfg = route.map;
    const key = username || bot?.username || 'bot';

    // уже стоим в запретной зоне — ходить отсюда нельзя, зовём варп
    const standingIn = zones?.blocks?.(bot.entity.position);
    if (standingIn && !cfg.entryWarp) {
        logFn?.(`walk → бот в зоне «${standingIn}», а варпа нет — стою`);
        return { ok: false, reason: 'in_zone' };
    }

    const cached = loadShopMap();
    const onMap = !standingIn && cached?.cells
        && isOnShopFlatMap(cached.cells, bot.entity.position, { maxDist: cfg.onMapMaxDist });

    if (!onMap && cfg.entryWarp) {
        logFn?.(`walk → entryWarp ${cfg.entryWarp} (не на территории)`);
        try {
            bot.chat(cfg.entryWarp);
        } catch {
            /* ignore */
        }
        const wait = await sleepAbortable(cfg.entryWarpWaitMs, bot, shouldAbort);
        if (wait) return { ok: false, reason: wait };
        shopSessions.delete(key);
    }

    let map;
    try {
        map = await ensureShopFlatMap(bot, {
            radiusXZ: cfg.radiusXZ,
            minFlatCells: cfg.minFlatCells,
            maxAgeMs: cfg.maxAgeMs,
            rescanDist: cfg.rescanDist,
            maxCells: cfg.maxCells,
            zones,
            log: logFn,
        });
    } catch (err) {
        logFn?.(`walk → shop_map fail: ${err?.message || err}`);
        return { ok: false, reason: 'map_fail' };
    }
    if (typeof shouldAbort === 'function' && shouldAbort()) return { ok: false, reason: 'abort' };
    if (!bot?.entity) return { ok: false, reason: 'gone' };
    if (!isOnShopFlatMap(map.cells, bot.entity.position, {
        maxDist: Math.max(cfg.onMapMaxDist, 8),
    })) {
        logFn?.('walk → shop_map: бот вне сетки');
        shopSessions.delete(key);
        return { ok: false, reason: 'off_map' };
    }

    const blocked = loadBlockedCells();
    const freshBlocks = new Map();

    const newRoute = (why) => {
        const prev = shopSessions.get(key);
        const pts = generateSpreadMapRoute(map.cells, bot.entity.position, {
            username: key,
            legsMin: cfg.legsMin,
            legsMax: Math.max(cfg.legsMin, cfg.legsMax),
            goalDistMin: cfg.goalDistMin,
            goalDistMax: Math.max(cfg.goalDistMin, cfg.goalDistMax),
            warpOrigin: map.origin,
            blocked,
            visited: prev?.visited,
            freshBonus: cfg.freshBonus,
            rng,
            log: logFn,
        });
        if (pts.length < 2) return null;
        const session = {
            mapAt: map.dumpedAt,
            createdAt: Date.now(),
            remaining: pts.slice(1),
            walkedTotal: 0,
            /** последние касания стен — по ним достраиваем препятствия */
            obstacles: prev?.obstacles || [],
            /** где уже топтались: карта бесконечная, круги наматывать незачем */
            visited: prev?.visited || new Map(),
        };
        shopSessions.set(key, session);
        logFn?.(`walk → новый план (${why}) точек=${session.remaining.length}`);
        return session;
    };

    let session = shopSessions.get(key);
    if (
        !session
        || session.mapAt !== map.dumpedAt
        || !session.remaining?.length
        || Date.now() - session.createdAt > cfg.sessionMaxMs
    ) {
        session = newRoute(session ? 'план пройден/устарел' : 'старт воркера');
        if (!session) return { ok: false, reason: 'no_route' };
    }
    if (!session.visited) session.visited = new Map();

    const budget = cfg.cycleDistMin + rng() * (cfg.cycleDistMax - cfg.cycleDistMin);
    const deadline = Date.now() + route.maxMs;
    const opts = {
        arriveXZ: route.arriveXZ,
        lookAlignRad: route.lookAlignRad,
        lookMaxMs: route.lookMaxMs,
        shouldAbort,
        deadline,
        log: logFn,
        zones,
    };

    const markVisited = (pos) => {
        if (!pos) return;
        const vk = visitKey(pos.x, pos.z);
        session.visited.set(vk, (session.visited.get(vk) || 0) + 1);
        // память о следах не должна расти вечно на бесконечной карте
        if (session.visited.size > 4000) {
            const drop = session.visited.keys().next().value;
            session.visited.delete(drop);
        }
    };

    logFn?.(
        `walk → кусок ~${budget.toFixed(0)}м, в плане ${session.remaining.length} точек`
        + ` (пройдено ${session.walkedTotal.toFixed(0)}м, известно ${map.walkableCount} клеток)`,
    );

    let travelled = 0;
    let legsDone = 0;
    let replans = 0;
    let regens = 0;
    let stop = { ...bot.entity.position };
    let quit = null;
    let lastStuckSpot = null;
    let stuckSameSpot = 0;

    const finish = (reason) => {
        clearMoveControls(bot);
        saveBlockedCells(freshBlocks);
        session.walkedTotal += travelled;
        const ok = legsDone > 0 && travelled >= 6;
        logFn?.(
            `walk → ${ok ? 'кусок пройден' : 'кусок не удался'} (${reason})`
            + ` ${travelled.toFixed(0)}м legs=${legsDone} replan=${replans}`
            + ` осталось точек=${session.remaining.length}`,
        );
        return {
            ok,
            reason: ok ? reason : (reason === 'budget' ? 'no_progress' : reason),
            stop,
            legs: legsDone,
        };
    };

    try {
        while (travelled < budget) {
            if (typeof shouldAbort === 'function' && shouldAbort()) return { ok: false, reason: 'abort', stop, legs: legsDone };
            if (!bot?.entity) return { ok: false, reason: 'gone', stop, legs: legsDone };
            if (Date.now() >= deadline) return finish('timeout');

            if (!session.remaining.length) {
                if (regens >= 2) return finish('plan_done');
                regens += 1;
                const next = newRoute('план закончился');
                if (!next) return finish('plan_done');
                session = next;
                continue;
            }

            const waypoint = session.remaining[0];
            // снимок координат: bot.entity.position подменяется каждый тик физики
            const before = { ...bot.entity.position };
            if (xzDist(before.x, before.z, waypoint.x, waypoint.z) <= route.arriveXZ) {
                session.remaining.shift();
                continue;
            }

            // длинную прямую режем — есть промежуточные проверки прогресса
            const subs = densifyChain(before, [waypoint], 9);
            let failed = null;
            for (const sub of subs) {
                const res = await walkOneLeg(bot, sub, opts);
                if (res === 'ok') continue;
                if (res === 'abort' || res === 'gone') {
                    quit = res;
                    break;
                }
                failed = res;
                break;
            }
            if (quit) return { ok: false, reason: quit, stop, legs: legsDone };

            const after = { ...bot.entity.position };
            travelled += xzDist(before.x, before.z, after.x, after.z);
            stop = after;
            markVisited(after);

            if (!failed) {
                session.remaining.shift();
                legsDone += 1;
                continue;
            }
            if (failed === 'timeout') return finish('timeout');

            // зона рядом: цель недостижима безопасно, снимаем её и идём дальше
            if (failed === 'zone') {
                session.remaining.shift();
                logFn?.('walk → точка у запретной зоны снята');
                if (!session.remaining.length && regens < 2) {
                    regens += 1;
                    const next = newRoute('упёрлись в зону');
                    if (next) session = next;
                }
                continue;
            }

            // застряли: прыжок, затем обход препятствия по карте
            await tryJumpUnstick(bot, logFn);
            if (typeof shouldAbort === 'function' && shouldAbort()) return { ok: false, reason: 'abort', stop, legs: legsDone };
            if (!bot?.entity) return { ok: false, reason: 'gone', stop, legs: legsDone };

            const pos = { ...bot.entity.position };
            // то же самое место? значит прошлый обход не помог — расширяем пятно
            const spot = `${Math.round(pos.x)},${Math.round(pos.z)}`;
            if (spot === lastStuckSpot) stuckSameSpot += 1;
            else {
                lastStuckSpot = spot;
                stuckSameSpot = 0;
            }
            const hit = markObstacle({
                blocked,
                fresh: freshBlocks,
                from: pos,
                target: waypoint,
                recent: session.obstacles,
                repeats: stuckSameSpot,
            });
            session.obstacles.push({ x: hit.cell.x, z: hit.cell.z });
            if (session.obstacles.length > 8) session.obstacles.shift();
            logFn?.(
                `walk → препятствие (${hit.cell.x}, ${hit.cell.z}) [${failed}]`
                + ` +${hit.marked} клеток${hit.wall ? ', достроил стену' : ''}`
                + (stuckSameSpot ? ` повтор x${stuckSameSpot}` : ''),
            );

            // дважды застряли на одном месте — не долбиться, брать другую цель
            if (stuckSameSpot >= 2) {
                if (regens >= 2) return finish('stuck_area');
                regens += 1;
                replans = 0;
                stuckSameSpot = 0;
                const next = newRoute('место непроходимо');
                if (!next) return finish('stuck_area');
                session = next;
                continue;
            }

            let rerouted = false;
            const lookAhead = Math.min(3, session.remaining.length);
            for (let j = 0; j < lookAhead; j++) {
                const detour = replanLeg(map.cells, pos, session.remaining[j], { blocked });
                if (detour.length < 2) continue;
                session.remaining.splice(0, j + 1, ...detour);
                rerouted = true;
                replans += 1;
                logFn?.(`walk → обход найден: +${detour.length} точек (через #${j})`);
                break;
            }

            if (!rerouted) {
                session.remaining.shift();
                replans += 1;
                logFn?.('walk → обхода нет, снимаю точку');
            }
            if (replans > cfg.replanMax) {
                if (regens >= 2) return finish('stuck_area');
                regens += 1;
                replans = 0;
                const next = newRoute('слишком много обходов');
                if (!next) return finish('stuck_area');
                session = next;
            }
        }
        return finish('budget');
    } finally {
        clearMoveControls(bot);
    }
}

/**
 * Прогулка: look→прямая по вейпоинтам до случайной точки на 25–50% длины маршрута.
 * stuck / ловушка z≈21 → один /spawn за прогулку, затем продолжаем с ближайшей точки.
 * @returns {Promise<{ ok: boolean, reason: string, stop?: object, legs?: number }>}
 */
export async function walkRandomRouteStop(bot, {
    shouldAbort = null,
    log = null,
    routePath = WALK_ROUTE_PATH,
    rng = Math.random,
    username = '',
} = {}) {
    const logFn = typeof log === 'function' ? log : null;
    const route = loadWalkRoute(routePath);
    if (route.missing) {
        logFn?.(`walk → нет маршрута (${route.error || routePath})`);
        return { ok: false, reason: 'no_route' };
    }
    if (route.mode === 'fixed' && route.points.length < 2) {
        logFn?.(`walk → нет маршрута (${routePath})`);
        return { ok: false, reason: 'no_route' };
    }

    if (!bot?.entity) return { ok: false, reason: 'gone' };

    const zones = compileZones(route.forbiddenZones, {
        margin: route.zoneMargin,
        log: logFn,
    });
    if (zones.size) logFn?.(`walk → запретные зоны (+${zones.margin}): ${zones.describe()}`);

    if (route.mode === 'shop_map') {
        return walkShopMapSession(bot, route, { shouldAbort, log: logFn, rng, username, zones });
    }

    let spawnCount = 0;
    const maybeSpawn = async (reason) => {
        if (!route.spawnOnStuck || spawnCount >= 2) return 'skip';
        const r = await chatSpawnRecover(bot, {
            shouldAbort,
            waitMs: route.spawnWaitMs,
            spawnPoint: route.spawnPoint,
            log: logFn,
            reason,
        });
        if (r === 'ok') spawnCount += 1;
        return r;
    };

    // fixed spawn-loop: всегда начинаем от спавна
    // shop_map/random+/warp: не тащим /spawn — иначе снесёт с shop
    if (!route.skipSpawnHome && bot.entity) {
        const d0 = xzDist(
            bot.entity.position.x,
            bot.entity.position.z,
            route.spawnPoint.x,
            route.spawnPoint.z,
        );
        if (d0 > 5 || isPlazaBarrierTrap(bot.entity.position)) {
            const r = await maybeSpawn(d0 > 5 ? 'pre_walk' : 'barrier_trap');
            if (r === 'abort') return { ok: false, reason: 'abort' };
            if (r === 'gone') return { ok: false, reason: 'gone' };
            if (r === 'failed' || (bot.entity && isPlazaBarrierTrap(bot.entity.position))) {
                logFn?.('walk → abort: не удалось встать на спавн');
                return { ok: false, reason: 'spawn_barrier', legs: 0 };
            }
        }
    }

    if (route.preWalkChat) {
        logFn?.(`walk → preChat ${route.preWalkChat}`);
        try {
            bot.chat(route.preWalkChat);
        } catch {
            /* ignore */
        }
        const deadline = Date.now() + route.preWalkChatWaitMs;
        while (Date.now() < deadline) {
            if (typeof shouldAbort === 'function' && shouldAbort()) {
                return { ok: false, reason: 'abort' };
            }
            if (!bot?.entity) return { ok: false, reason: 'gone' };
            await sleep(200);
        }
        if (typeof shouldAbort === 'function' && shouldAbort()) {
            return { ok: false, reason: 'abort' };
        }
        if (!bot?.entity) return { ok: false, reason: 'gone' };
    }

    let pts = route.points;
    let useLoop = route.loop;

    if (route.mode === 'random') {
        const origin = bot.entity.position;
        const rcfg = route.random;
        pts = generateRandomFlatRoute(origin, {
            legsMin: rcfg.legsMin,
            legsMax: Math.max(rcfg.legsMin, rcfg.legsMax),
            legLenMin: rcfg.legLenMin,
            legLenMax: Math.max(rcfg.legLenMin, rcfg.legLenMax),
            radiusMax: rcfg.radiusMax,
            rng,
        });
        useLoop = false;
        logFn?.(
            `walk → random route @(${origin.x.toFixed(0)},${origin.z.toFixed(0)})`
            + ` pts=${pts.length} r≤${rcfg.radiusMax}`,
        );
    }

    const total = routeTotalLength(pts, useLoop);
    if (total < 2) return { ok: false, reason: 'route_too_short' };

    const loop = useLoop;
    const frac =
        route.stopFracMin + rng() * (route.stopFracMax - route.stopFracMin);
    const stopDist = total * frac;

    const buildTargets = () => {
        const { x, z } = bot.entity.position;
        const near = nearestPointIndex(pts, x, z, route.arriveXZ);
        const fromIdx = near.index;
        const stop = pointAlongRoute(pts, fromIdx, stopDist, loop);
        if (!stop) return { targets: [], stop: null, fromIdx, near };
        const targets = [];
        if (!near.onPoint) targets.push(pts[fromIdx]);
        targets.push(...buildLegTargets(pts, fromIdx, stop, loop));
        return { targets, stop, fromIdx, near };
    };

    let { targets, stop, fromIdx, near } = buildTargets();
    if (!stop || !targets.length) return { ok: false, reason: 'bad_stop' };

    const beforeDense = targets.length;
    const denseStep = route.mode === 'shop_map' ? 8.5 : 5.5;
    targets = densifyChain(bot.entity.position, targets, denseStep);

    logFn?.(
        `walk → ${Math.round(frac * 100)}% вдоль (${stopDist.toFixed(0)}/${total.toFixed(0)}м)`
        + ` from#${fromIdx} → stop (${stop.x.toFixed(1)}, ${stop.z.toFixed(1)})`
        + ` legs=${targets.length}`
        + (beforeDense !== targets.length ? ` (dense ${beforeDense}→${targets.length})` : '')
        + (near.onPoint ? ' on_point' : ''),
    );

    const deadline = Date.now() + route.maxMs;
    const opts = {
        arriveXZ: route.arriveXZ,
        lookAlignRad: route.lookAlignRad,
        lookMaxMs: route.lookMaxMs,
        shouldAbort,
        deadline,
        log: logFn,
        zones,
    };

    let lastStop = stop;
    let done = 0;
    let stuckStreak = 0;
    let jumpTried = false;

    const finishPartial = (reason) => {
        if (done >= 2) {
            logFn?.(
                `walk → partial ok (${reason}) stop (${lastStop.x.toFixed(1)}, ${lastStop.z.toFixed(1)})`
                + ` legs=${done}`,
            );
            return { ok: true, reason: 'partial', stop: lastStop, legs: done };
        }
        return { ok: false, reason, stop: lastStop, legs: done };
    };

    try {
        for (let leg = 0; leg < targets.length; leg++) {
            if (typeof shouldAbort === 'function' && shouldAbort()) {
                return { ok: false, reason: 'abort', stop: lastStop, legs: done };
            }
            if (Date.now() >= deadline) {
                return finishPartial('timeout');
            }

            const target = targets[leg];
            lastStop = target;
            logFn?.(
                `walk → leg ${leg + 1}/${targets.length}: → (${target.x.toFixed(1)}, ${target.y.toFixed(0)}, ${target.z.toFixed(1)})`,
            );

            const res = await walkOneLeg(bot, target, opts);
            if (res === 'abort') return { ok: false, reason: 'abort', stop: lastStop, legs: done };
            if (res === 'gone') return { ok: false, reason: 'gone', stop: lastStop, legs: done };
            if (res === 'timeout') return finishPartial('timeout');
            if (res === 'zone') {
                // фиксированный маршрут ведёт в зону — дальше по нему нельзя
                return finishPartial('zone');
            }
            if (res === 'stuck' || res === 'offtrack') {
                stuckStreak++;

                // уже отошли — anti-AFK ок, не биться о стену
                if (done >= 3 && res === 'stuck') {
                    return finishPartial('enough_walk');
                }

                if (!jumpTried && res === 'stuck' && bot.entity) {
                    jumpTried = true;
                    await tryJumpUnstick(bot, logFn);
                    const retry = await walkOneLeg(bot, target, opts);
                    if (retry === 'ok') {
                        stuckStreak = 0;
                        jumpTried = false;
                        done++;
                        continue;
                    }
                }

                if (res === 'stuck' && stuckStreak <= 2) {
                    logFn?.(
                        `walk → skip waypoint (${target.x.toFixed(1)}, ${target.z.toFixed(1)})`
                        + ` streak=${stuckStreak}`,
                    );
                    continue;
                }

                const trap = bot.entity && isPlazaBarrierTrap(bot.entity.position);
                if (trap || res === 'offtrack' || stuckStreak >= 3) {
                    if (done >= 2) {
                        return finishPartial(res === 'offtrack' ? 'offtrack' : 'enough_walk');
                    }
                    // на shop не /spawn — иначе сорвём плоскость
                    if (route.skipSpawnHome) {
                        return finishPartial(res === 'offtrack' ? 'offtrack' : 'all_stuck');
                    }
                    const sr = await maybeSpawn(
                        res === 'offtrack'
                            ? 'offtrack'
                            : (trap ? 'stuck_barrier' : 'stuck'),
                    );
                    if (sr === 'abort') return { ok: false, reason: 'abort', stop: lastStop, legs: done };
                    if (sr === 'gone') return { ok: false, reason: 'gone', stop: lastStop, legs: done };
                    if (sr === 'failed') return finishPartial('spawn_failed');
                    if (sr === 'ok') {
                        const rebuilt = buildTargets();
                        if (rebuilt.stop && rebuilt.targets.length) {
                            targets = densifyChain(
                                bot.entity.position,
                                rebuilt.targets,
                                denseStep,
                            );
                            stop = rebuilt.stop;
                            lastStop = stop;
                            leg = -1;
                            stuckStreak = 0;
                            jumpTried = false;
                            logFn?.(
                                `walk → resume after spawn legs=${targets.length} `
                                + `stop (${stop.x.toFixed(1)}, ${stop.z.toFixed(1)})`,
                            );
                        }
                        continue;
                    }
                    return finishPartial(res === 'offtrack' ? 'offtrack' : 'all_stuck');
                }
                continue;
            }
            stuckStreak = 0;
            jumpTried = false;
            done++;
        }

        if (done <= 0) {
            logFn?.(`walk → fail all stuck (last ${lastStop.x.toFixed(1)}, ${lastStop.z.toFixed(1)})`);
            return { ok: false, reason: 'all_stuck', stop: lastStop, legs: 0 };
        }

        logFn?.(`walk → arrived (${lastStop.x.toFixed(1)}, ${lastStop.z.toFixed(1)}) legs=${done}`);
        return { ok: true, reason: 'ok', stop: lastStop, legs: done };
    } finally {
        clearMoveControls(bot);
    }
}
