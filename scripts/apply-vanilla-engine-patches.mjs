/**
 * Повторно накатывает vanilla-правки на node_modules после npm i:
 * - mineflayer physics: 1 tick / fire (без wall-clock catchup)
 * - prismarine-physics: float accel 0.16277136 + fround heading/friction
 *
 * Usage: node scripts/apply-vanilla-engine-patches.mjs
 */
import fs from 'fs';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function resolvePkg(name) {
    return dirname(require.resolve(`${name}/package.json`));
}

function patchFile(filePath, replacements, label) {
    let src = fs.readFileSync(filePath, 'utf8');
    let n = 0;
    for (const { from, to, id, already } of replacements) {
        const marker = already || to;
        // Уникальный маркер патча — не первые символы `to` (они часто совпадают со stock).
        if (src.includes(marker) && !src.includes(from)) {
            console.log(`[skip] ${label}: ${id} (already)`);
            continue;
        }
        if (!src.includes(from)) {
            console.warn(`[miss] ${label}: ${id}`);
            continue;
        }
        src = src.replace(from, to);
        n++;
        console.log(`[ok] ${label}: ${id}`);
    }
    if (n) fs.writeFileSync(filePath, src);
    return n;
}

const mfPhysics = join(resolvePkg('mineflayer'), 'lib/plugins/physics.js');
const ppIndex = join(resolvePkg('prismarine-physics'), 'index.js');

const doPhysicsOld = `  // This function should be executed each tick (every 0.05 seconds)
  // How it works: https://gafferongames.com/post/fix_your_timestep/

  // WARNING: THIS IS NOT ACCURATE ON WINDOWS (15.6 Timer Resolution)
  // use WSL or switch to Linux
  // see: https://discord.com/channels/413438066984747026/519952494768685086/901948718255833158
  let timeAccumulator = 0
  let catchupTicks = 0
  function doPhysics () {
    const now = performance.now()
    const deltaSeconds = (now - lastPhysicsFrameTime) / 1000
    lastPhysicsFrameTime = now

    timeAccumulator += deltaSeconds
    catchupTicks = 0
    while (timeAccumulator >= PHYSICS_TIMESTEP) {
      tickPhysics(now)
      timeAccumulator -= PHYSICS_TIMESTEP
      catchupTicks++
      if (catchupTicks >= PHYSICS_CATCHUP_TICKS) break
    }
  }`;

const doPhysicsNew = `  // 20 TPS: ровно один клиентский тик на срабатывание таймера.
  // Пачку catchup по wall-clock не гоняем — иначе рваный motion ≠ ваниль / FunAC.
  // (Точный schedule: lib/vanilla-tick.mjs подменяет setInterval(50) из этого файла.)
  let timeAccumulator = 0
  let catchupTicks = 0
  function doPhysics () {
    const now = performance.now()
    lastPhysicsFrameTime = now
    timeAccumulator = 0
    catchupTicks = 0
    tickPhysics(now)
  }`;

const headingOld = `  function applyHeading (entity, strafe, forward, multiplier) {
    let speed = Math.sqrt(strafe * strafe + forward * forward)
    if (speed < 0.01) return new Vec3(0, 0, 0)

    speed = multiplier / Math.max(speed, 1)

    strafe *= speed
    forward *= speed

    const yaw = Math.PI - entity.yaw
    const sin = Math.sin(yaw)
    const cos = Math.cos(yaw)

    const vel = entity.vel
    vel.x -= strafe * cos + forward * sin
    vel.z += forward * cos - strafe * sin
  }`;

const headingNew = `  function applyHeading (entity, strafe, forward, multiplier) {
    let speed = Math.sqrt(strafe * strafe + forward * forward)
    if (speed < 0.01) return new Vec3(0, 0, 0)

    speed = multiplier / Math.max(speed, 1)

    strafe *= speed
    forward *= speed

    const yaw = Math.PI - entity.yaw
    const sin = Math.sin(yaw)
    const cos = Math.cos(yaw)

    const vel = entity.vel
    // JVM float: LivingEntity.travel heading
    vel.x = Math.fround(vel.x - Math.fround(strafe * cos + forward * sin))
    vel.z = Math.fround(vel.z + Math.fround(forward * cos - strafe * sin))
  }`;

const accelOld = `        // Calculate what the speed is (0.1 if no modification)
        const attributeSpeed = attribute.getAttributeValue(playerSpeedAttribute)
        inertia = (blockSlipperiness[blockUnder.type] || physics.defaultSlipperiness) * 0.91
        acceleration = attributeSpeed * (0.1627714 / (inertia * inertia * inertia))
        if (acceleration < 0) acceleration = 0 // acceleration should not be negative
      } else {
        acceleration = physics.airborneAcceleration
        inertia = physics.airborneInertia

        if (entity.control.sprint) {
          const airSprintFactor = physics.airborneAcceleration * 0.3
          acceleration += airSprintFactor
        }
      }

      applyHeading(entity, strafe, forward, acceleration)

      if (isOnLadder(world, pos)) {
        vel.x = math.clamp(-physics.ladderMaxSpeed, vel.x, physics.ladderMaxSpeed)
        vel.z = math.clamp(-physics.ladderMaxSpeed, vel.z, physics.ladderMaxSpeed)
        vel.y = Math.max(vel.y, entity.control.sneak ? 0 : -physics.ladderMaxSpeed)
      }

      moveEntity(entity, world, vel.x, vel.y, vel.z)

      if (isOnLadder(world, pos) && (entity.isCollidedHorizontally ||
        (supportFeature('climbUsingJump') && entity.control.jump))) {
        vel.y = physics.ladderClimbSpeed // climb ladder
      }

      // Apply friction and gravity
      if (entity.levitation > 0) {
        vel.y += (0.05 * entity.levitation - vel.y) * 0.2
      } else {
        vel.y -= physics.gravity * gravityMultiplier
      }
      vel.y *= physics.airdrag
      vel.x *= inertia
      vel.z *= inertia
    }
  }`;

const accelNew = `        // Calculate what the speed is (0.1 if no modification)
        const attributeSpeed = attribute.getAttributeValue(playerSpeedAttribute)
        // slip * 0.91f as float; accel factor 0.16277136f (yarn LivingEntity)
        inertia = Math.fround((blockSlipperiness[blockUnder.type] || physics.defaultSlipperiness) * 0.91)
        const inertia3 = Math.fround(Math.fround(inertia * inertia) * inertia)
        acceleration = Math.fround(attributeSpeed * Math.fround(Math.fround(0.16277136) / inertia3))
        if (acceleration < 0) acceleration = 0 // acceleration should not be negative
      } else {
        acceleration = physics.airborneAcceleration
        inertia = physics.airborneInertia

        if (entity.control.sprint) {
          const airSprintFactor = physics.airborneAcceleration * 0.3
          acceleration += airSprintFactor
        }
      }

      applyHeading(entity, strafe, forward, acceleration)

      if (isOnLadder(world, pos)) {
        vel.x = math.clamp(-physics.ladderMaxSpeed, vel.x, physics.ladderMaxSpeed)
        vel.z = math.clamp(-physics.ladderMaxSpeed, vel.z, physics.ladderMaxSpeed)
        vel.y = Math.max(vel.y, entity.control.sneak ? 0 : -physics.ladderMaxSpeed)
      }

      moveEntity(entity, world, vel.x, vel.y, vel.z)

      if (isOnLadder(world, pos) && (entity.isCollidedHorizontally ||
        (supportFeature('climbUsingJump') && entity.control.jump))) {
        vel.y = physics.ladderClimbSpeed // climb ladder
      }

      // Apply friction and gravity (float like Entity.travel)
      if (entity.levitation > 0) {
        vel.y += (0.05 * entity.levitation - vel.y) * 0.2
      } else {
        vel.y = Math.fround(vel.y - Math.fround(physics.gravity * gravityMultiplier))
      }
      vel.y = Math.fround(vel.y * physics.airdrag)
      vel.x = Math.fround(vel.x * inertia)
      vel.z = Math.fround(vel.z * inertia)
      pos.x = Math.fround(pos.x)
      pos.y = Math.fround(pos.y)
      pos.z = Math.fround(pos.z)
    }
  }`;

let total = 0;
total += patchFile(
    mfPhysics,
    [{
        from: doPhysicsOld,
        to: doPhysicsNew,
        id: 'single-tick doPhysics',
        already: 'ровно один клиентский тик на срабатывание таймера',
    }],
    'mineflayer/physics.js',
);
total += patchFile(
    ppIndex,
    [
        {
            from: headingOld,
            to: headingNew,
            id: 'fround applyHeading',
            already: 'JVM float: LivingEntity.travel heading',
        },
        {
            from: accelOld,
            to: accelNew,
            id: 'float ground accel+friction',
            already: '0.16277136',
        },
    ],
    'prismarine-physics',
);

console.log(total ? `patched ${total} hunk(s)` : 'nothing to patch (already applied or upstream changed)');
