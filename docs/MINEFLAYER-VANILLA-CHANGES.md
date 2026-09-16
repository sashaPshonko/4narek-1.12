# Mineflayer / physics — что мы меняем под ваниль

Дата фиксации: 2026-09-16 (обновлено: floor-watchdog / reconcile).  
Стек: `mineflayer` ^4.37 + `prismarine-physics` (через зависимости mineflayer).  
Цель: поведение ближе к Notchian 1.21.x на FunTime, без Java-клиента.

Патчи в `node_modules` **не в git** (`node_modules/` в `.gitignore`).  
После `npm i` накатывает `postinstall` → `scripts/apply-vanilla-engine-patches.mjs`.

---

## 1. Слой в репо (наши модули)

| Файл | Что делает |
|------|------------|
| `lib/vanilla-move.mjs` | Единый walk-patch: полный `player_input` (7 флагов), `tick_end` после move и на каждый physics tick, `fround` в move-пакетах, `hasHorizontalCollision` из `bot.entity.isCollidedHorizontally`, **sprint выключен** (ignore `true` + глотаем `start_sprinting`) |
| `lib/walk-121.mjs` | Re-export `patchWalking` / `patchWalking121` → `vanilla-move` |
| `lib/vanilla-tick.mjs` | Хук `setInterval(50)` из `mineflayer/.../physics.js` → абсолютный 20 TPS (`nextAt += 50`), при лаге resync без пачки тиков |
| `lib/vanilla-physics.mjs` | `maxCatchupTicks: 1`, fround entity, константы LivingEntity, обёртка `simulatePlayer`, **reconcile Δpos** (`forcedMove`; варпы >4 блоков не в avg) |
| `lib/vanilla-client.mjs` | brand/settings + импорт `vanilla-tick` до createBot |
| `lib/vanilla-resource-pack.mjs` | ACCEPTED → пауза download → DOWNLOADED → LOADED (не мгновенно) |
| `lib/floor-watchdog.mjs` | Падение → `/warp shop`; **не** триггерит без загруженного чанка; антиспам 15с; physics off на время warp |
| `lib/walk-route.mjs` | sprint больше не включается при маршруте |
| `4narek-old.mjs` / `4NAREK.mjs` / `4narek-roles.mjs` | `patchWalking` + `patchVanillaPhysics({ log })` |

Stock mineflayer сам по себе этого не делает.

---

## 2. Патч `mineflayer/lib/plugins/physics.js`

Файл: `node_modules/mineflayer/lib/plugins/physics.js`  
Накат: `scripts/apply-vanilla-engine-patches.mjs` (hunk `single-tick doPhysics`).

### Было (stock)
- `setInterval(doPhysics, 50)`
- внутри `doPhysics`: аккумулятор wall-clock → несколько `tickPhysics` подряд (`maxCatchupTicks`, по умолчанию 4)

### Стало
- Таймер по-прежнему стартует как `setInterval(..., 50)`, но **перехватывается** `lib/vanilla-tick.mjs` (точный schedule).
- `doPhysics` вызывает **ровно один** `tickPhysics` — без catchup-пачки по wall-clock.

Зачем: рваный motion и пачки тиков после лага event loop ≠ ванильный клиент / FunAC.

---

## 3. Патч `prismarine-physics/index.js`

Файл: `node_modules/prismarine-physics/index.js`  
Накат: тот же скрипт (hunks `fround applyHeading`, `float ground accel+friction`).

### Ground acceleration
- Было: `0.1627714 / (inertia³)` на double  
- Стало: `Math.fround(0.16277136)` (yarn LivingEntity) + fround цепочки slip×0.91 и inertia³

### `applyHeading`
- Было: `vel.x -= …` / `vel.z += …` на double  
- Стало: присвоение через `Math.fround` (как float в JVM)

### После friction / gravity (normal movement)
- `vel.y/x/z` и `pos.x/y/z` прогоняются через `Math.fround`

Entity–entity коллизии не трогали (на FunTime между игроками обычно выкл).

---

## 4. Что stock mineflayer всё ещё делает «по-своему» (не закрыто этим)

- Полный порт `LivingEntity.travel` / `moveEntity` AABB на double внутри коллизий блоков  
- Вода / лава / мёд / elytra — без полного float-прохода  
- `bot.look` GCD есть, но anti-AFK голову **намеренно не крутим** (FunAC раньше цеплял look)  
- Chat signing, полный client fingerprint кроме brand/settings/RP  

Метрика: в логах воркера строка `reconcile Δpos: n=… avg=… max=…` раз в минуту.

---

## 5. Как применить / проверить на VPS

```bash
cd ~/4narek-1.12   # или /root/4narek-1.12
git pull
npm i              # postinstall накатит патчи в node_modules
node scripts/apply-vanilla-engine-patches.mjs   # идемпотентно, можно вручную
# рестарт оркестраторов 502 / 504
```

Проверка патчей:
```bash
grep -n "single-tick\|0.16277136\|fround(vel" \
  node_modules/mineflayer/lib/plugins/physics.js \
  node_modules/prismarine-physics/index.js
```
