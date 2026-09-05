/**
 * Пауза, если event loop уже залип — чтобы не слать пачку кликов/look
 * после «заморозки» (похоже на краш/лаг клиента → античит).
 */
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();

let eluLast = performance.eventLoopUtilization();
let lastWarnAt = 0;

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {object} [opts]
 * @param {number} [opts.p99LimitMs] — порог p99 за свежее окно
 * @param {number} [opts.maxWaitMs]
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<boolean>} true если loop ок (или дождались), false если ушли по таймауту всё ещё грязно
 */
export async function waitForEventLoopOk(opts = {}) {
    const p99LimitMs = opts.p99LimitMs ?? 45;
    const maxLimitMs = opts.maxLimitMs ?? 120;
    const maxWaitMs = opts.maxWaitMs ?? 4000;
    const log = opts.log;
    const started = Date.now();
    let waited = false;

    while (Date.now() - started < maxWaitMs) {
        histogram.reset();
        await sleep(80);

        const p99 = histogram.percentile(99) / 1e6;
        const max = histogram.max / 1e6;
        const elu = performance.eventLoopUtilization(eluLast);
        eluLast = performance.eventLoopUtilization();
        const util = (elu?.utilization ?? 0) * 100;

        if (p99 <= p99LimitMs && max <= maxLimitMs && util < 92) {
            if (waited && log) {
                log(`event-loop ok после ${Date.now() - started}мс (p99=${p99.toFixed(1)}ms)`);
            }
            return true;
        }

        if (!waited) {
            waited = true;
            if (log && Date.now() - lastWarnAt > 5000) {
                lastWarnAt = Date.now();
                log(
                    `event-loop lag → жду (p99=${p99.toFixed(1)} max=${max.toFixed(1)} elu=${util.toFixed(0)}%)`,
                );
            }
        }
        await sleep(50 + Math.floor(Math.random() * 100));
    }

    if (log) {
        log(`event-loop всё ещё тяжёлый после ${maxWaitMs}мс — продолжаю осторожно`);
    }
    return false;
}
