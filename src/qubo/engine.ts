// Qubo's rules, with no drawing: the cube stands on top of a tower that slowly tips over toward the next one,
// faster and faster, like an upside-down pendulum. Tap and the cube is thrown off the top along the way the
// tower is leaning, so the timing of the tap sets how far it flies. Wait too long and the tower falls with it. Land on the next tower to score; miss it, or hit its side, and the cube falls.
// Everything is in a 360×420 world; the page scales it to the screen.

export const W = 360;
export const H = 420;
export const CUBE = 42;
export const START_RIGHT = 96; // where the standing tower's right edge sits on screen

const THROW = 600; // launch speed along the tower's axis
const GRAVITY = 1800;
const MIN_TOP = 225;
const MAX_TOP = 295;
const TOPPLE = 1100; // degrees/s² pulling a leaning tower over once it has been left
const SLIDE = GRAVITY * 1.15; // slightly stronger gravity-driven sliding along the tower
const FRICTION = 0.16; // lower kinetic/static friction for quicker, more natural sliding
const ACC = 8; // quicker tower acceleration leaves a tighter timing window
const ACC_LEAN = 0.9; // gentler acceleration as the tower leans
const FALL_AT = 82; // degrees: past this the cube slides off with the tower

export interface Tower { x: number; w: number; top: number; tipStart: number; tipAccel: number; leanAccel: number; rhythm: number }
/** A tower left behind: either it is carried out of view during a jump, or it topples after a fall. */
export interface Fallen { pivot: number; w: number; len: number; angle: number; vel: number; fixed?: boolean }
export type Phase = 'wait' | 'air' | 'scroll' | 'rescue' | 'drop' | 'over';

export interface World {
  phase: Phase;
  towers: Tower[]; // the one the cube stands on, the next to land on, and one more beyond it
  angle: number; // lean in degrees, positive toward the next tower
  vel: number; // degrees/s the tower is tipping at
  fallen: Fallen[];
  offset: number; // how far the cube sits from the middle of its tower's top, along the top; it stays where it landed
  slide: number; // px/s the cube is sliding along the tower's top
  landed: number; // which tower ahead the cube came down on: 1 is the next, 2 the one beyond
  cubeAngle: number; // degrees the cube is tilted
  cubeSpin: number; // degrees/s: rotation speed while airborne
  cubeX: number; // left edge
  cubeY: number; // bottom edge
  vx: number;
  vy: number;
  cam: number; // world x at the screen's left edge
  camTarget: number;
  score: number;
  over: boolean;
  rescueAvailable: boolean; // one recovery jump after sliding/falling off a fresh landing
  rescueInPlace: boolean; // an in-place hop must not move the tower or camera
}

const between = (rng: () => number, lo: number, hi: number) => lo + rng() * (hi - lo);
const rad = (d: number) => (d * Math.PI) / 180;

export const pivotX = (t: Tower) => t.x + t.w / 2;
export const towerLen = (t: Tower) => H - t.top;

function nextTower(from: Tower, rng: () => number, score: number): Tower {
  const w = CUBE;
  const top = Math.max(MIN_TOP, Math.min(MAX_TOP, from.top + between(rng, -45, 45)));

  // Keep spacing genuinely varied, while accounting for the height change:
  // a higher destination shortens the safe gap; a lower one allows a little more.
  const heightDelta = from.top - top;
  const difficulty = Math.min(1, score / 30);
  const minGap = 78 + 4 * difficulty;
  const maxGap = Math.max(112, Math.min(148, 140 + heightDelta * 0.38 + 8 * difficulty));
  const gap = between(rng, minGap, maxGap);

  return {
    x: from.x + from.w + gap, w, top,
    // Give every tower a distinct tipping tempo instead of making them move in lockstep.
    tipStart: between(rng, 3.2, 6),
    tipAccel: between(rng, 0.72, 1.28),
    leanAccel: between(rng, 0.65, 1.35),
    rhythm: between(rng, 0.82, 1.18),
  };
}

/** Puts the cube on the tip of the current tower, leaning by `angle` degrees. */
function seat(w: World) {
  const t = w.towers[0];
  const a = rad(w.angle);
  const tipX = pivotX(t) + towerLen(t) * Math.sin(a) + w.offset * Math.cos(a);
  const tipY = H - towerLen(t) * Math.cos(a) + w.offset * Math.sin(a);
  // The cube is positioned by its centre: move half its width along the tower-top normal.
  w.cubeX = tipX + (CUBE / 2) * Math.sin(a) - CUBE / 2;
  w.cubeY = tipY - (CUBE / 2) * Math.cos(a) + CUBE / 2;
  w.cubeAngle = Math.round(w.cubeAngle / 90) * 90 + w.angle;
}

export function createWorld(rng: () => number = Math.random): World {
  const a: Tower = { x: START_RIGHT - 44, w: 44, top: 270, tipStart: 3.5, tipAccel: 0.9, leanAccel: 0.85, rhythm: 0.94 };
  const b = nextTower(a, rng, 0);
  const w: World = {
    phase: 'wait', towers: [a, b, nextTower(b, rng, 0)], angle: 0, vel: a.tipStart,
    fallen: [], offset: 0, slide: 0, landed: 1, cubeAngle: 0, cubeSpin: 0, cubeX: 0, cubeY: 0, vx: 0, vy: 0, cam: 0, camTarget: 0, score: 0, over: false, rescueAvailable: false, rescueInPlace: false,
  };
  seat(w);
  return w;
}

/** Throws the cube off the top of the tower, along the lean, plus the speed the tip is swinging at. */
export function launch(w: World) {
  const fromScroll = w.phase === 'scroll';
  // A forward jump is always available while the cube is on the landing
  // platform, even if it is still rotating or sliding.
  // The in-place rescue is reserved for losing balance off the REAR edge;
  // that condition sets rescueAvailable when offset crosses the rear limit.
  const inPlace = w.phase === 'drop' && w.rescueAvailable;
  const rescue = inPlace;
  if (w.phase !== 'wait' && !rescue && !fromScroll) return;
  const activeIndex = (fromScroll || rescue) ? w.landed : 0;
  const t = w.towers[activeIndex];
  const a = rad(w.angle);
  const tip = (towerLen(t) + ((fromScroll || rescue) ? w.offset : 0)) * rad(w.vel); // velocity of the cube's support point
  w.vx = THROW * Math.sin(a) + (tip + w.slide) * Math.cos(a);
  w.vy = -THROW * Math.cos(a) + (tip + w.slide) * Math.sin(a);
  // A balance-saving hop is vertical and returns to this same platform.
  if (inPlace) { w.vx = 0; w.vy = -THROW; }

  // A stationary balance hop keeps the current platform in place; a forward
  // jump retires the tower being left as usual.
  if (!inPlace) w.fallen.push({ pivot: pivotX(t), w: t.w, len: towerLen(t), angle: w.angle, vel: 0, fixed: true });

  if (rescue) {
    // Keep the same platform under the cube during a balance-saving hop.
    w.rescueAvailable = false;
    w.rescueInPlace = inPlace;
    w.cubeSpin += 180;
    w.phase = 'rescue';
    return;
  }

  if (fromScroll) {
    // Normal forward jump: retire the platform just left and promote the
    // destination platform so the usual [current,next,next+1] flight layout
    // and camera handoff continue unchanged.
    for (let k = 0; k < activeIndex; k++) {
      w.towers.shift();
      w.towers.push(nextTower(w.towers[w.towers.length - 1], Math.random, w.score));
    }
    w.landed = 1;
    w.rescueInPlace = false;
  }

  // Preserve existing rotation while taking off from a rolling landing;
  // on a settled tower, start the familiar launch spin.
  if (!fromScroll) w.cubeSpin = 900 + Math.min(360, w.vel * 1.2);
  else w.cubeSpin += 180;
  w.phase = 'air';
}

export function step(w: World, dt: number, rng: () => number = Math.random) {
  for (const f of w.fallen) {
    if (f.fixed || Math.abs(f.angle) >= 90) continue;
    f.vel += TOPPLE * Math.sin(rad(f.angle)) * dt;
    f.angle = Math.max(-90, Math.min(90, f.angle + f.vel * dt));
  }
  // Keep toppled towers until they are safely outside the camera view. Their bases
  // can extend well beyond the pivot while falling, so include their full length.
  w.fallen = w.fallen.filter((f) => f.pivot + f.len > w.cam - 80);
  switch (w.phase) {
    case 'wait':
      const tower = w.towers[0];
      w.vel += (ACC * tower.tipAccel + ACC_LEAN * tower.leanAccel * w.angle) * tower.rhythm * (1 + Math.min(0.35, w.score * 0.018)) * dt;
      w.angle += w.vel * dt;
      {
        // The cube slides down the tilted top, toward the next tower, once the lean beats friction.
        const a = rad(w.angle);
        w.slide += SLIDE * Math.max(0, Math.sin(a) - FRICTION * Math.cos(a)) * dt;
        w.offset += w.slide * dt;
      }
      seat(w);
      // As the landed tower bends, move the camera with its tip. Its base is
      // pulled out through the rear-left corner while the next tower shifts by
      // exactly the same amount, preserving the gap between the towers.
      {
        const cameraAim = pivotX(tower) + towerLen(tower) * Math.sin(rad(w.angle)) - (START_RIGHT - 22);
        w.cam += (cameraAim - w.cam) * (1 - Math.exp(-10 * dt));
        w.camTarget = w.cam;
      }
      if (w.angle >= FALL_AT || w.offset > w.towers[0].w / 2 + CUBE * 0.3) {
        // Too late: the cube slides off the edge, or the tower goes over, and takes the cube with it.
        const t = w.towers[0];
        w.fallen.push({ pivot: pivotX(t), w: t.w, len: towerLen(t), angle: w.angle, vel: w.vel });
        w.vx = towerLen(t) * rad(w.vel) * Math.cos(rad(w.angle)) + w.slide;
        w.vy = 0;
        w.phase = 'drop';
      }
      break;
    case 'air': {
      const prev = w.cubeY;
      const prevAngle = w.cubeAngle;
      w.cubeAngle += w.cubeSpin * dt;
      w.cubeSpin *= Math.exp(-0.18 * dt); // gentler air resistance keeps the faster spin going longer
      w.vy += GRAVITY * dt;
      w.cubeX += w.vx * dt;
      w.cubeY += w.vy * dt;
      // During the jump, bring the tower the cube is approaching toward the
      // starting tower's screen position (near the left corner). This carries
      // the previous tower out of view before the cube lands.
      const flightCenterX = w.cubeX + CUBE / 2;
      // Switch to the farther platform only after the cube passes the midpoint
      // between platforms; using the near platform's edge switches too early
      // and can send the camera past a valid landing on that near platform.
      const targetIndex = w.towers.length > 2 && flightCenterX > (pivotX(w.towers[1]) + pivotX(w.towers[2])) / 2 ? 2 : 1;
      const landingTower = w.towers[targetIndex];
      const targetCam = Math.max(0, pivotX(landingTower) - (START_RIGHT - 22));
      // Keep the cube inside the playfield even while the camera hands off
      // between candidate landing platforms or the jump is going to miss.
      const minCam = Math.max(0, flightCenterX - W + 80);
      const maxCam = Math.max(0, flightCenterX - 80);
      const cameraAim = Math.max(minCam, Math.min(targetCam, maxCam));
      w.cam += (cameraAim - w.cam) * (1 - Math.exp(-10 * dt));
      const half = CUBE / 2;
      const bounds = (x: number, bottom: number, angle: number) => {
        const a = rad(angle), cs = Math.cos(a), sn = Math.sin(a);
        const points = [[-half, -half], [half, -half], [half, half], [-half, half]].map(([px, py]) => ({
          x: x + half + px * cs - py * sn,
          y: bottom - half + px * sn + py * cs,
        }));
        return {
          minY: Math.min(...points.map(p => p.y)),
          maxY: Math.max(...points.map(p => p.y)),
          minX: Math.min(...points.map(p => p.x)),
          maxX: Math.max(...points.map(p => p.x)),
        };
      };
      const before = bounds(w.cubeX - w.vx * dt, prev, prevAngle);
      const current = bounds(w.cubeX, w.cubeY, w.cubeAngle);
      const centerX = w.cubeX + half;
      // The next two towers are both in reach: landing on the far one skips the middle one.
      for (let i = 1; i < w.towers.length; i++) {
        const t = w.towers[i];
        if (current.maxX <= t.x || current.minX >= t.x + t.w) continue;
        // The platform contacts the cube's lowest rotated edge/corner (maxY),
        // not its upper edge. Using minY made the cube pass through the platform
        // before the landing was registered, causing a one-frame disappearance.
        const crossedTop = w.vy > 0 && before.maxY <= t.top + 0.5 && current.maxY >= t.top;
        if (crossedTop) {
          // Contact is determined by the rotated square itself. Any part of its
          // lower edge/corner may touch the platform; the centre need not be above it.
          const contactLeft = Math.max(current.minX, t.x);
          const contactRight = Math.min(current.maxX, t.x + t.w);
          if (contactLeft >= contactRight) {
            w.vx = 0;
            w.phase = 'drop';
            return;
          }
          // Correct only vertical penetration at first contact. Never change the
          // cube's angle or pull its centre toward the platform centre.
          w.cubeY += t.top - current.maxY;
          w.offset = centerX - pivotX(t);
          // Keep the cube's landing rotation and some horizontal momentum.
          // Its tilted attitude and residual spin now influence how it settles.
          w.vx *= 0.5;
          w.vy = 0;
          w.score += i;
          w.landed = i;
          w.camTarget = w.cam;
          w.angle = 0;
          w.vel = w.towers[w.landed].tipStart;
          const spinDrift = -Math.sign(w.cubeSpin) * Math.min(55, Math.abs(w.cubeSpin) * CUBE / 360);
          w.slide = w.vx * 0.45 + spinDrift;
          w.phase = 'scroll';
          return;
        }
        if (current.minY > t.top + 6 && current.maxX > t.x && current.minX < t.x + t.w) { w.vx = 0; w.phase = 'drop'; return; }
      }
      if (w.cubeY > H + CUBE) { w.phase = 'over'; w.over = true; }
      break;
    }
    case 'scroll': {
      // Start carrying the landed tower backward as soon as contact is made.
      // Following its tip makes the base travel out through the rear of the scene,
      // while the cube stays supported and remains jumpable during the movement.
      const landedTower = w.towers[w.landed];
      w.vel += (ACC * landedTower.tipAccel + ACC_LEAN * landedTower.leanAccel * w.angle) * landedTower.rhythm * (1 + Math.min(0.35, w.score * 0.018)) * dt;
      w.angle += w.vel * dt;
      const cameraAim = Math.max(0, pivotX(landedTower) + towerLen(landedTower) * Math.sin(rad(w.angle)) - (START_RIGHT - 22));
      w.cam += (cameraAim - w.cam) * (1 - Math.exp(-10 * dt));
      w.camTarget = w.cam;
      const half = CUBE / 2;
      const a = rad(w.angle);
      const relative = w.cubeAngle - w.angle;
      const flatRelative = Math.round(relative / 90) * 90;
      const angleError = relative - flatRelative;
      // Gravity supplies the restoring torque around the cube's current support
      // corner/edge. It rotates continuously; no target angle is assigned.
      const gravityTorque = -(GRAVITY / (CUBE * 0.72)) * Math.sin(rad(angleError)) * (180 / Math.PI);
      w.cubeSpin += (gravityTorque - (w.cubeSpin - w.vel) * 2.8) * dt;
      w.cubeAngle += w.cubeSpin * dt;

      // Gravity can move the cube either way along the sloping top. Friction opposes motion.
      const slope = Math.sin(a);
      const frictionLimit = FRICTION * Math.cos(a);
      const drive = Math.abs(slope) > frictionLimit
        ? Math.sign(slope) * (Math.abs(slope) - frictionLimit)
        : 0;
      if (drive) w.slide += SLIDE * drive * dt;
      else if (Math.abs(w.slide) > 0.1) {
        w.slide -= Math.sign(w.slide) * Math.min(Math.abs(w.slide), SLIDE * frictionLimit * dt);
      } else w.slide = 0;
      w.offset += w.slide * dt;

      // Keep the cube supported by the actual rotated top, not by a horizontal screen line.
      const ca = rad(w.cubeAngle);
      const support = half * (Math.abs(Math.sin(ca - a)) + Math.abs(Math.cos(ca - a)));
      const tipX = pivotX(landedTower) + towerLen(landedTower) * Math.sin(a);
      const tipY = H - towerLen(landedTower) * Math.cos(a);
      const centerX = tipX + w.offset * Math.cos(a) + support * Math.sin(a);
      const centerY = tipY + w.offset * Math.sin(a) - support * Math.cos(a);
      w.cubeX = centerX - half;
      w.cubeY = centerY + half;

      // Either end can run out from under the cube, including the rear edge.
      const alongSupport = half * (Math.abs(Math.cos(ca - a)) + Math.abs(Math.sin(ca - a)));
      if (w.offset > landedTower.w / 2 + alongSupport || w.offset < -landedTower.w / 2 - alongSupport || w.angle >= FALL_AT) {
        // Give the player one last recovery jump while preserving this exact
        // landing tower. It keeps tipping and moving out of view as usual.
        w.rescueAvailable = true;
        w.vx = w.slide * Math.cos(a) + towerLen(landedTower) * rad(w.vel) * Math.cos(a);
        w.vy = w.slide * Math.sin(a) + towerLen(landedTower) * rad(w.vel) * Math.sin(a);
        w.phase = 'drop';
        return;
      }
      if (Math.abs(angleError) < 7 && Math.abs(w.cubeSpin - w.vel) < 40 && Math.abs(w.slide) < 30) {
        for (let k = 0; k < w.landed; k++) {
          w.towers.shift();
          w.towers.push(nextTower(w.towers[w.towers.length - 1], rng, w.score));
        }
        // Keep earlier toppled towers in the scene; the camera filter removes them only
        // after they have actually moved out of view.
        // Keep the exact lean and angular velocity used to render the landing tower.
        // The same tower is now index 0, so resetting these values would make it snap upright.
        w.cubeSpin = w.vel;
        w.phase = 'wait';
        seat(w);
      }
      break;
    }
    case 'rescue': {
      // Keep the landing tower's established motion/camera follow running
      // while the cube makes a short recovery arc back onto that same tower.
      const t = w.towers[w.landed];
      const previousTowerAngle = w.angle;
      if (!w.rescueInPlace) {
        w.vel += (ACC * t.tipAccel + ACC_LEAN * t.leanAccel * w.angle) * t.rhythm * (1 + Math.min(0.35, w.score * 0.018)) * dt;
        w.angle += w.vel * dt;
        const cameraAim = Math.max(0, pivotX(t) + towerLen(t) * Math.sin(rad(w.angle)) - (START_RIGHT - 22));
        w.cam += (cameraAim - w.cam) * (1 - Math.exp(-10 * dt));
        w.camTarget = w.cam;
      }

      const previousX = w.cubeX + CUBE / 2;
      const previousY = w.cubeY - CUBE / 2;
      const previousAngle = w.cubeAngle;
      w.vy += GRAVITY * dt;
      w.cubeX += w.vx * dt;
      w.cubeY += w.vy * dt;
      w.cubeAngle += w.cubeSpin * dt;
      w.cubeSpin *= Math.exp(-0.32 * dt);

      const a = rad(w.angle), cs = Math.cos(a), sn = Math.sin(a);
      const local = (cx: number, cy: number, angle: number) => {
        const oldA = rad(angle), oldCos = Math.cos(oldA), oldSin = Math.sin(oldA);
        const dx = cx - pivotX(t), dy = cy - H;
        return { x: dx * oldCos + dy * oldSin, y: -dx * oldSin + dy * oldCos };
      };
      const half = CUBE / 2;
      const currentCenterX = w.cubeX + half;
      const currentCenterY = w.cubeY - half;
      const before = local(previousX, previousY, previousTowerAngle);
      const current = local(currentCenterX, currentCenterY, w.angle);
      const beforeSupport = half * (Math.abs(Math.sin(rad(previousAngle - previousTowerAngle))) + Math.abs(Math.cos(rad(previousAngle - previousTowerAngle))));
      const support = half * (Math.abs(Math.sin(rad(w.cubeAngle - w.angle))) + Math.abs(Math.cos(rad(w.cubeAngle - w.angle))));
      const len = towerLen(t);
      const crossed = current.y + support >= -len && before.y + beforeSupport <= -len + 1 && (w.vx * -sn + w.vy * cs) > 0;
      const alongSupport = half * (Math.abs(Math.cos(rad(w.cubeAngle - w.angle))) + Math.abs(Math.sin(rad(w.cubeAngle - w.angle))));
      if (crossed && current.x + alongSupport >= -t.w / 2 && current.x - alongSupport <= t.w / 2) {
        // Place the cube on the same sloped top using its actual rotated support.
        const localY = -len - support;
        const worldX = pivotX(t) + current.x * cs - localY * sn;
        const worldY = H + current.x * sn + localY * cs;
        w.cubeX = worldX - half;
        w.cubeY = worldY + half;
        w.offset = current.x;
        w.slide = 0;
        w.rescueAvailable = false;
        w.rescueInPlace = false;
        w.phase = 'scroll';
        return;
      }
      if (w.cubeY > H + CUBE || current.x > t.w / 2 + 180 || current.x < -t.w / 2 - 180) {
        w.fallen.push({ pivot: pivotX(t), w: t.w, len, angle: w.angle, vel: w.vel });
        w.rescueInPlace = false;
        w.phase = 'drop';
      }
      break;
    }
    case 'drop':
      w.vy += GRAVITY * dt;
      w.cubeAngle += w.cubeSpin * dt;
      w.cubeX += w.vx * dt;
      w.cubeY += w.vy * dt;
      if (w.cubeY > H + CUBE) { w.phase = 'over'; w.over = true; }
      break;
  }
}
