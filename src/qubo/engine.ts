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
const SCROLL = 420;
const MIN_TOP = 225;
const MAX_TOP = 295;
const TOPPLE = 1100; // degrees/s² pulling a leaning tower over once it has been left
const SLIDE = 420; // px/s² the cube slides along a tilted top, before friction
const FRICTION = 0.34; // it only starts to slide once the lean is steeper than this (as tan)
const START_VEL = 6; // degrees/s a fresh tower starts tipping at
const ACC = 15; // degrees/s² of tipping at the start, and
const ACC_LEAN = 2.2; // how much more for each degree it already leans
const FALL_AT = 82; // degrees: past this the cube slides off with the tower

export interface Tower { x: number; w: number; top: number }
/** A tower the cube has left: it keeps tipping and topples over, lying on the ground. */
export interface Fallen { pivot: number; w: number; len: number; angle: number; vel: number }
export type Phase = 'wait' | 'air' | 'scroll' | 'drop' | 'over';

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
}

const between = (rng: () => number, lo: number, hi: number) => lo + rng() * (hi - lo);
const rad = (d: number) => (d * Math.PI) / 180;

export const pivotX = (t: Tower) => t.x + t.w / 2;
export const towerLen = (t: Tower) => H - t.top;

function nextTower(from: Tower, rng: () => number, score: number): Tower {
  const spread = Math.min(1, score / 25); // gaps widen and towers narrow as you go
  const gap = between(rng, 40, 90 + 70 * spread);
  const w = CUBE;
  const top = Math.max(MIN_TOP, Math.min(MAX_TOP, from.top + between(rng, -45, 45)));
  return { x: from.x + from.w + gap, w, top };
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
  w.cubeAngle = w.angle;
}

export function createWorld(rng: () => number = Math.random): World {
  const a: Tower = { x: START_RIGHT - 44, w: 44, top: 270 };
  const b = nextTower(a, rng, 0);
  const w: World = {
    phase: 'wait', towers: [a, b, nextTower(b, rng, 0)], angle: 0, vel: START_VEL,
    fallen: [], offset: 0, slide: 0, landed: 1, cubeAngle: 0, cubeSpin: 0, cubeX: 0, cubeY: 0, vx: 0, vy: 0, cam: 0, camTarget: 0, score: 0, over: false,
  };
  seat(w);
  return w;
}

/** Throws the cube off the top of the tower, along the lean, plus the speed the tip is swinging at. */
export function launch(w: World) {
  if (w.phase !== 'wait') return;
  const t = w.towers[0];
  const a = rad(w.angle);
  const tip = towerLen(t) * rad(w.vel); // tip speed, across the tower
  w.vx = THROW * Math.sin(a) + (tip + w.slide) * Math.cos(a);
  w.vy = -THROW * Math.cos(a) + (tip + w.slide) * Math.sin(a);
  w.fallen.push({ pivot: pivotX(t), w: t.w, len: towerLen(t), angle: w.angle, vel: w.vel });
  // Give the cube a visible, steady spin as it leaves the tower.
  w.cubeSpin = 420 + Math.min(180, w.vel * 0.8);
  w.phase = 'air';
}

export function step(w: World, dt: number, rng: () => number = Math.random) {
  for (const f of w.fallen) {
    if (Math.abs(f.angle) >= 90) continue;
    f.vel += TOPPLE * Math.sin(rad(f.angle)) * dt;
    f.angle = Math.max(-90, Math.min(90, f.angle + f.vel * dt));
  }
  w.fallen = w.fallen.filter((f) => f.pivot > w.cam - 300);
  switch (w.phase) {
    case 'wait':
      w.vel += (ACC + ACC_LEAN * w.angle) * (1 + Math.min(0.6, w.score * 0.03)) * dt;
      w.angle += w.vel * dt;
      {
        // The cube slides down the tilted top, toward the next tower, once the lean beats friction.
        const a = rad(w.angle);
        w.slide += SLIDE * Math.max(0, Math.sin(a) - FRICTION * Math.cos(a)) * dt;
        w.offset += w.slide * dt;
      }
      seat(w);
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
      w.cubeAngle += w.cubeSpin * dt;
      w.cubeSpin *= Math.exp(-0.32 * dt); // air resistance makes the rotation ease naturally
      w.vy += GRAVITY * dt;
      w.cubeX += w.vx * dt;
      w.cubeY += w.vy * dt;
      const half = CUBE / 2;
      const a = rad(w.cubeAngle);
      const support = half * (Math.abs(Math.sin(a)) + Math.abs(Math.cos(a)));
      const prevBottom = prev - half + support;
      const currentBottom = w.cubeY - half + support;
      const centerX = w.cubeX + half;
      const left = centerX - support;
      const right = centerX + support;
      // The next two towers are both in reach: landing on the far one skips the middle one.
      for (let i = 1; i < w.towers.length; i++) {
        const t = w.towers[i];
        if (right <= t.x || left >= t.x + t.w) continue;
        if (w.vy > 0 && prevBottom <= t.top + 0.5 && currentBottom >= t.top && centerX >= t.x - support && centerX <= t.x + t.w + support) {
          // Keep the cube's landing angle. Its lowest rotated corner/edge rests on the platform.
          w.cubeY += t.top - currentBottom;
          w.offset = Math.max(-t.w / 2, Math.min(t.w / 2, centerX - pivotX(t)));
          // Keep the impact rotation: the cube should roll off its corner instead of snapping flat.
          w.vx = 0; w.vy = 0;
          w.score += i; // a tower skipped counts too
          w.landed = i;
          w.camTarget = t.x + t.w - START_RIGHT;
          w.phase = 'scroll';
          return;
        }
        if (currentBottom > t.top + 6) { w.vx = 0; w.phase = 'drop'; return; } // hit the side
      }
      if (w.cubeY > H + CUBE) { w.phase = 'over'; w.over = true; }
      break;
    }
    case 'scroll': {
      w.cam = Math.min(w.camTarget, w.cam + SCROLL * dt);
      // While the camera moves, let the cube settle onto a face with a damped
      // rotational spring. A square is face-aligned at multiples of 90°.
      const flatAngle = Math.round(w.cubeAngle / 90) * 90;
      const angleError = flatAngle - w.cubeAngle;
      const angularAcceleration = angleError * 34 - w.cubeSpin * 11;
      w.cubeSpin += angularAcceleration * dt;
      w.cubeAngle += w.cubeSpin * dt;
      // Keep the lowest rotated corner/edge in contact with the landing surface.
      const landedTower = w.towers[w.landed];
      const half = CUBE / 2;
      const a = rad(w.cubeAngle);
      const support = half * (Math.abs(Math.sin(a)) + Math.abs(Math.cos(a)));
      w.cubeY = landedTower.top + half - support;
      if (w.cam >= w.camTarget) {
        for (let k = 0; k < w.landed; k++) {
          w.towers.shift();
          w.towers.push(nextTower(w.towers[w.towers.length - 1], rng, w.score));
        }
        w.fallen = []; // the toppled tower has scrolled away
        w.angle = 0;
        w.vel = START_VEL;
        w.slide = 0;
        w.cubeSpin = 0;
        w.phase = 'wait';
        seat(w);
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
