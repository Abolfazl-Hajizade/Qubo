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
const SHORT_TOWER_LAUNCH_ANGLE = 22; // short platforms must bend this far before a forward jump

export interface Tower { x: number; w: number; top: number; tipStart: number; tipAccel: number; leanAccel: number; rhythm: number; moveOrigin?: number; moveAmplitude?: number; moveSpeed?: number; movePhase?: number; moveTime?: number; moveTopOrigin?: number; isShort?: boolean }
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
  landingAge: number; // seconds elapsed since the latest landing
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
const leanSpeedMultiplier = (score: number) => score >= 20 && score < 30 ? 1.08 : 1;

export const pivotX = (t: Tower) => t.x + t.w / 2;
export const towerLen = (t: Tower) => H - t.top;

function nextTower(from: Tower, rng: () => number, score: number): Tower {
  // From score 30, occasionally generate a narrower landing platform.
  // Never place two narrow platforms back-to-back so each challenge stays readable.
  const endlessWorld = score >= 800;
  const narrowChance = (score >= 100 ? 0.25 : score >= 60 ? 0.20 : score >= 30 ? 0.12 : 0)
    + (endlessWorld ? 0.05 : 0);
  const w = from.w >= CUBE && rng() < narrowChance ? Math.round(CUBE * 0.6) : CUBE;
  // After 70 points, rotate the focus of the challenge every three points:
  // height variation, tower speed, then jump distance.
  const challengeMode = score < 70 ? -1 : Math.floor(((endlessWorld ? 800 : score) - 70) / 3) % 3;
  const intensity = endlessWorld ? 1.05 : 1;
  const heightSwing = (45 + (challengeMode === 0 ? 17 : 0)) * intensity;
  const generatedTop = Math.max(MIN_TOP, Math.min(MAX_TOP, from.top + between(rng, -heightSwing, heightSwing)));
  // From score 300, occasionally create a platform about 25% shorter; avoid consecutive short platforms.
  const isShort = score >= 300 && !from.isShort && rng() < (0.12 + (endlessWorld ? 0.05 : 0));
  const top = isShort ? H - (H - generatedTop) * 0.75 : generatedTop;

  // Keep spacing varied and account for the height change.
  const heightDelta = from.top - top;
  const showSecondTower = rng() < (0.28 + (endlessWorld ? 0.05 : 0));
  const gapBoost = (challengeMode === 2 ? 14 : 0) * intensity;
  const minGap = (showSecondTower ? 78 : 102) + gapBoost;
  const maxGap = showSecondTower
    ? Math.max(minGap + 8, Math.min(134, 112 + heightDelta * 0.25 + gapBoost))
    : Math.max(minGap + 8, Math.min(162, 140 + heightDelta * 0.38 + gapBoost));
  const gap = between(rng, minGap, maxGap) * intensity;

  const speedBoost = challengeMode === 1;
  const x = from.x + from.w + gap;
  // From score 100, platforms may drift sideways; from 200, some move vertically instead.
  const movementRoll = rng();
  const movementChance = 0.15 + (endlessWorld ? 0.05 : 0);
  const movesSideways = score >= 100 && movementRoll < movementChance;
  const movesVertically = score >= 200 && movementRoll >= movementChance && movementRoll < movementChance * 2;
  return {
    x, w, top,
    ...(isShort ? { isShort: true } : {}),
    ...(movesSideways ? { moveOrigin: x, moveAmplitude: between(rng, 10, 16) * intensity, moveSpeed: between(rng, 0.65, 0.9) * intensity, movePhase: between(rng, 0, Math.PI * 2), moveTime: 0 } : {}),
    ...(movesVertically ? { moveTopOrigin: top, moveAmplitude: between(rng, 6, 10) * intensity, moveSpeed: between(rng, 0.65, 0.9) * intensity, movePhase: between(rng, 0, Math.PI * 2), moveTime: 0 } : {}),
    tipStart: between(rng, speedBoost ? 4.2 : 3.2, speedBoost ? 7.1 : 6) * intensity,
    tipAccel: between(rng, speedBoost ? 0.9 : 0.72, speedBoost ? 1.42 : 1.28) * intensity,
    leanAccel: between(rng, speedBoost ? 0.85 : 0.65, speedBoost ? 1.48 : 1.35) * intensity,
    rhythm: between(rng, speedBoost ? 0.9 : 0.82, speedBoost ? 1.24 : 1.18) * intensity,
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

/** Create a world at the locally saved checkpoint; this score is not a leaderboard submission. */
export function createWorld(rng: () => number = Math.random, initialScore = 0): World {
  const a: Tower = { x: START_RIGHT - 44, w: 44, top: 270, tipStart: 3.5, tipAccel: 0.9, leanAccel: 0.85, rhythm: 0.94 };
  const b = nextTower(a, rng, initialScore);
  const towers = [a, b];
  while (towers.length < 6) towers.push(nextTower(towers[towers.length - 1], rng, initialScore));
  const w: World = {
    phase: 'wait', towers, angle: 0, vel: a.tipStart,
    fallen: [], offset: 0, slide: 0, landed: 1, landingAge: 0, cubeAngle: 0, cubeSpin: 0, cubeX: 0, cubeY: 0, vx: 0, vy: 0, cam: 0, camTarget: 0, score: initialScore, over: false, rescueAvailable: false, rescueInPlace: false,
  };
  seat(w);
  return w;
}

/** Throws the cube off the top of the tower, along the lean, plus the speed the tip is swinging at. */
export interface LaunchOptions { skipRearCornerHop?: boolean }

export function launch(w: World, options: LaunchOptions = {}) {
  const fromScroll = w.phase === 'scroll';
  // A forward jump is always available while the cube is on the landing
  // platform, even if it is still rotating or sliding.
  // The in-place rescue is reserved for losing balance off the REAR edge;
  // that condition sets rescueAvailable when offset crosses the rear limit.
  const quickRearCornerHop = !options.skipRearCornerHop && fromScroll &&
    w.landingAge <= 0.35 &&
    w.offset <= -w.towers[w.landed].w * 0.2;
  const quickFrontCornerHop = fromScroll &&
    w.landingAge <= 0.35 &&
    w.offset >= w.towers[w.landed].w * 0.2;
  const inPlace = (w.phase === 'drop' && w.rescueAvailable) || quickRearCornerHop;
  const rescue = inPlace;
  if (w.phase !== 'wait' && !rescue && !fromScroll) return;
  const activeIndex = (fromScroll || rescue) ? w.landed : 0;
  const t = w.towers[activeIndex];
  // Short platforms require a deliberate wait before a forward jump.
  // A rear-corner in-place hop is a balance recovery, not a forward launch,
  // so the short-platform timing gate must not silently cancel that recovery.
  if (fromScroll && !inPlace && t.isShort && w.angle < SHORT_TOWER_LAUNCH_ANGLE) return;
  const a = rad(w.angle);
  const tip = (towerLen(t) + ((fromScroll || rescue) ? w.offset : 0)) * rad(w.vel); // velocity of the cube's support point
  w.vx = THROW * Math.sin(a) + (tip + w.slide) * Math.cos(a);
  w.vy = -THROW * Math.cos(a) + (tip + w.slide) * Math.sin(a);
  // A short recovery hop rises just enough to clear the cube, with a small forward drift.
  if (inPlace) { w.vx = THROW * 0.14; w.vy = -THROW * 0.6; }
  // A quick jump from the front corner is explicitly a forward hop, even if
  // residual sliding/tower motion would otherwise weaken or reverse its launch.
  if (quickFrontCornerHop) w.vx = Math.max(w.vx, THROW * 0.55);

  // A stationary balance hop keeps the current platform in place; a forward
  // jump retires the tower being left as usual.
  if (!inPlace) w.fallen.push({ pivot: pivotX(t), w: t.w, len: towerLen(t), angle: w.angle, vel: 0, fixed: true });

  if (rescue) {
    // Keep the same platform under the cube during a balance-saving hop.
    w.rescueAvailable = false;
    w.rescueInPlace = inPlace;
    // Make a balance-saving hop feel like a deliberate, powerful recovery.
    w.cubeSpin += 720;
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
  // Move only upcoming platforms; a platform freezes as soon as it becomes the landing surface.
  const firstMovingIndex = w.phase === 'scroll' || w.phase === 'rescue' ? w.landed + 1 : 1;
  for (let i = firstMovingIndex; i < w.towers.length; i++) {
    const t = w.towers[i];
    if (t.moveAmplitude === undefined || t.moveSpeed === undefined || t.movePhase === undefined) continue;
    t.moveTime = (t.moveTime ?? 0) + dt;
    const movement = Math.sin(t.moveTime * t.moveSpeed + t.movePhase) * t.moveAmplitude;
    if (t.moveOrigin !== undefined) t.x = t.moveOrigin + movement;
    if (t.moveTopOrigin !== undefined) t.top = t.moveTopOrigin + movement;
  }
  switch (w.phase) {
    case 'wait':
      const tower = w.towers[0];
      w.vel += (ACC * tower.tipAccel + ACC_LEAN * tower.leanAccel * w.angle) * tower.rhythm * leanSpeedMultiplier(w.score) * dt;
      w.angle += w.vel * dt;
      {
        // Gravity acts along the slope; friction always opposes the current slide.
        const a = rad(w.angle);
        const slopeForce = Math.sin(a);
        // Lower friction in the initial tipping phase makes the cube start
        // sliding with a smaller lean, while keeping motion physically damped.
        const friction = FRICTION * 0.55 * Math.cos(a);
        if (Math.abs(w.slide) > 0.1) {
          const direction = Math.sign(w.slide);
          const acceleration = SLIDE * (slopeForce - direction * friction);
          const nextSlide = w.slide + acceleration * dt;
          // Kinetic friction must stop the cube at zero, not reverse its direction.
          w.slide = Math.sign(nextSlide) !== direction && slopeForce * direction <= friction
            ? 0
            : nextSlide;
        } else if (Math.abs(slopeForce) > friction) {
          w.slide += SLIDE * (slopeForce - Math.sign(slopeForce) * friction) * dt;
        } else {
          w.slide = 0;
        }
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
      if (w.angle >= FALL_AT ||
          w.offset > w.towers[0].w / 2 + CUBE * 0.3 ||
          w.offset < -w.towers[0].w / 2 - CUBE * 0.3) {
        // Falling from either edge follows the tower's motion and the cube's slide.
        const t = w.towers[0];
        const a = rad(w.angle);
        w.fallen.push({ pivot: pivotX(t), w: t.w, len: towerLen(t), angle: w.angle, vel: w.vel });
        w.vx = (towerLen(t) * rad(w.vel) + w.slide) * Math.cos(a);
        w.vy = (towerLen(t) * rad(w.vel) + w.slide) * Math.sin(a);
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
          w.landingAge = 0;
          w.camTarget = w.cam;
          w.angle = 0;
          w.vel = w.towers[w.landed].tipStart;
          // Preserve horizontal landing momentum without converting cube spin
          // into an artificial force that can push it backward.
          w.slide = w.vx * 0.24;
          w.cubeSpin *= 0.42;
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
      w.landingAge += dt;
      w.vel += (ACC * landedTower.tipAccel + ACC_LEAN * landedTower.leanAccel * w.angle) * landedTower.rhythm * leanSpeedMultiplier(w.score) * dt;
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
      const gravityTorque = -(GRAVITY / (CUBE * 0.72)) * Math.sin(rad(angleError)) * (180 / Math.PI) * 0.28;
      // Softer gravity response and stronger damping prevent endless in-place spinning.
      w.cubeSpin += (gravityTorque - (w.cubeSpin - w.vel) * 4.2) * dt;
      w.cubeAngle += w.cubeSpin * dt;

      // Gravity can move the cube either way along the sloping top. Friction opposes motion.
      const slope = Math.sin(a);
      const frictionLimit = FRICTION * Math.cos(a);
      const slopeDrive = Math.abs(slope) > frictionLimit
        ? Math.sign(slope) * (Math.abs(slope) - frictionLimit)
        : 0;

      // Estimate the cube's footprint along the platform. If its centre of
      // mass passes beyond either edge, gravity creates a gentle pull toward
      // that edge instead of leaving the cube balanced on a single corner.
      const ca = rad(w.cubeAngle);
      // Only pull toward an edge after the cube's centre of mass passes it.
      // Using the rotated footprint here made a centred, merely tilted cube
      // appear to overhang both edges and caused an unexplained backward pull.
      const rearOverhang = Math.max(0, -w.offset - landedTower.w / 2);
      const frontOverhang = Math.max(0, w.offset - landedTower.w / 2);
      const edgeDrive = rearOverhang > 0
        ? -Math.min(0.7, rearOverhang / CUBE)
        : frontOverhang > 0
          ? Math.min(0.7, frontOverhang / CUBE)
          : 0;
      const drive = slopeDrive + edgeDrive;
      if (drive) w.slide += SLIDE * drive * 0.22 * dt;
      else if (Math.abs(w.slide) > 0.1) {
        w.slide -= Math.sign(w.slide) * Math.min(Math.abs(w.slide), SLIDE * frictionLimit * 0.45 * dt);
      } else w.slide = 0;
      w.offset += w.slide * dt;

      // Keep the cube supported by the actual rotated top, not by a horizontal screen line.
      const currentCubeAngle = rad(w.cubeAngle);
      const currentSupport = half * (Math.abs(Math.sin(currentCubeAngle - a)) + Math.abs(Math.cos(currentCubeAngle - a)));
      const tipX = pivotX(landedTower) + towerLen(landedTower) * Math.sin(a);
      const tipY = H - towerLen(landedTower) * Math.cos(a);
      const centerX = tipX + w.offset * Math.cos(a) + currentSupport * Math.sin(a);
      const centerY = tipY + w.offset * Math.sin(a) - currentSupport * Math.cos(a);
      w.cubeX = centerX - half;
      w.cubeY = centerY + half;

      // Either end can run out from under the cube, including the rear edge.
      const alongSupport = half * (Math.abs(Math.cos(ca - a)) + Math.abs(Math.sin(ca - a)));
      if (w.offset > landedTower.w / 2 + alongSupport || w.offset < -landedTower.w / 2 - alongSupport || w.angle >= FALL_AT) {
        // Give the player one last recovery jump while preserving this exact
        // landing tower. It keeps tipping and moving out of view as usual.
        // Only a loss of support past the rear edge grants an in-place rescue.
        w.rescueAvailable = w.offset < -landedTower.w / 2 - alongSupport;
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
        w.vel += (ACC * t.tipAccel + ACC_LEAN * t.leanAccel * w.angle) * t.rhythm * leanSpeedMultiplier(w.score) * dt;
        w.angle += w.vel * dt;
        const cameraAim = Math.max(0, pivotX(t) + towerLen(t) * Math.sin(rad(w.angle)) - (START_RIGHT - 22));
        w.cam += (cameraAim - w.cam) * (1 - Math.exp(-10 * dt));
        w.camTarget = w.cam;
      }

      const previousX = w.cubeX + CUBE / 2;
      const previousY = w.cubeY - CUBE / 2;
      const previousAngle = w.cubeAngle;
      // Use normal gravity so the shorter recovery hop comes back down promptly.
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
        // On a failed in-place recovery, keep the same tower in the scene;
        // the cube continues falling past the visible platforms until game over.
        if (!w.rescueInPlace) {
          w.fallen.push({ pivot: pivotX(t), w: t.w, len, angle: w.angle, vel: w.vel });
        }
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
