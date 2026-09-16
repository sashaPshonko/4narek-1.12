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
| `lib/vanilla-move.mjs` | Walk-patch: полный `player_input`, `tick_end` после move (**не** на каждый physicsTick — FunTime иначе глушит /ah), `fround` move, `hasHorizontalCollision`, sprint off |
| `lib/vanilla-physics.mjs` | LivingEntity / reconcile / ghost-fall |
| `4narek-old.mjs` | **16.09.2026:** `patchVanillaMove` + `patchVanillaPhysics` **выключены** в проде. A/B: с патчами entity на y≈70, `/clan` жив, `/ah`/`/balance`/`/warp` молчат; без патчей y≈82, AH открывается. RP timing / client settings остаются. Включать обратно только после фикса. |

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
