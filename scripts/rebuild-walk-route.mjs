#!/usr/bin/env node
/** Offline: spawn-map.json → walk-route.json */
import { rebuildWalkRouteFromSavedMap } from '../lib/spawn-map.mjs';

const loop = rebuildWalkRouteFromSavedMap({ start: { x: 0, z: 0 }, log: console.log });
if (!loop) process.exit(1);
console.log(loop.map((p) => `${p.x},${p.y},${p.z}`).join(' → '));
