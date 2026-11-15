// Qubo's rules, with no drawing: the cube stands on top of a tower that slowly tips over toward the next one,
// faster and faster, like an upside-down pendulum. Tap and the cube is thrown off the top along the way the
// tower is leaning, so the timing of the tap sets how far it flies. Wait too long and the tower falls with it.
// Everything is in a 360×420 world; the page scales it to the screen.

export const W = 360;
export const H = 420;
export const CUBE = 28;
export const START_RIGHT = 96;

const THROW = 560;
const GRAVITY = 1800;
const SCROLL = 420;
const MIN_TOP = 225;
const MAX_TOP = 295;
const TOPPLE = 1100;
const SLIDE = 760;
const FRICTION = 0.20;
const START_VEL = 6;
const ACC = 15;
const ACC_LEAN = 2.2;
const FALL_AT = 82;

export interface Tower { x: number; w: number; top: number }
export interface Fallen { pivot: number; w: number; len: number; angle: number; vel: number }
export type Phase = 'wait' | 'air' | 'scroll' | 'drop' | 'over';

export interface World {
  phase: Phase;
  towers: Tower[];
  angle: number;
  vel: number;
  fallen: Fallen[];
  offset: number;
  slide: number;
  landed: number;
  cubeAngle: number;
  cubeSpin: number;
  cubeX: number;
  cubeY: number;
  vx: number;
  vy: number;
  cam: number;
  camTarget: number;
  score: number;
  over: boolean;
}

const between = (rng: () => number, lo: number, hi: number) => lo + rng() * (hi - lo);
const rad = (d: number) => (d * Math.PI) / 180;

export const pivotX = (t: Tower) => t.x + t.w / 2;
export const towerLen = (t: Tower) => H - t.top;

function nextTower(from: Tower, rng: () => number, score: number): Tower {
  const spread = Math.min(1, score / 25);
  const gap = between(rng, 58, 112 + 75 * spread);
  const w = between(rng, 34 - 8 * spread, 48 - 12 * spread);
  const top = Math.max(MIN_TOP, Math.min(MAX_TOP, from.top + between(rng, -45, 45)));
  return { x: from.x + from.w + gap, w, top };
}

function seat(w: World) {
  const t = w.towers[0];
  const a = rad(w.angle);
  w.cubeX = pivotX(t) + towerLen(t) * Math.sin(a) + w.offset * Math.cos(a) - CUBE / 2;
  w.cubeY = H - towerLen(t) * Math.cos(a) + w.offset * Math.sin(a);
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

export function launch(w: World) {
  if (w.phase !== 'wait') return;
  const t = w.towers[0];
  const a = rad(w.angle);
  const tip = towerLen(t) * rad(w.vel);
  w.vx = THROW * Math.sin(a) + (tip + w.slide) * Math.cos(a);
  w.vy = -THROW * Math.cos(a) + (tip + w.slide) * Math.sin(a);
  // Give every jump a visible full-body spin, with extra rotation from the tower's motion.
  w.cubeSpin = 260 + w.vel * 1.6 + w.slide * 0.16;
  w.fallen.push({ pivot: pivotX(t), w: t.w, len: towerLen(t), angle: w.angle, vel: w.vel });
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
        const a = rad(w.angle);
        w.slide += SLIDE * Math.max(0, Math.sin(a) - FRICTION * Math.cos(a)) * dt;
        w.offset += w.slide * dt;
      }
      seat(w);
      if (w.angle >= FALL_AT || w.offset > w.towers[0].w / 2 + CUBE * 0.3) {
        const t = w.towers[0];
        w.fallen.push({ pivot: pivotX(t), w: t.w, len: towerLen(t), angle: w.angle, vel: w.vel });
        w.vx = towerLen(t) * rad(w.vel) * Math.cos(rad(w.angle)) + w.slide;
        w.vy = 0;
        w.phase = 'drop';
      }
      break;
    case 'air': {
      const prevY = w.cubeY;
      const prevAngle = w.cubeAngle;
      w.vy += GRAVITY * dt;
      w.cubeX += w.vx * dt;
      w.cubeY += w.vy * dt;
      w.cubeAngle += w.cubeSpin * dt;
      const half = CUBE / 2;
      const supportY = (angle: number) => half * Math.abs(Math.sin(rad(angle)));
      const halfWidth = (angle: number) => half * (Math.abs(Math.cos(rad(angle))) + Math.abs(Math.sin(rad(angle))));
      const prevBottom = prevY + supportY(prevAngle);
      const bottom = w.cubeY + supportY(w.cubeAngle);
      const left = w.cubeX + half - halfWidth(w.cubeAngle);
      const right = w.cubeX + half + halfWidth(w.cubeAngle);
      // Only the immediate next tower is a valid landing; distant towers cannot be skipped.
      const t = w.towers[1];
      if (right > t.x && left < t.x + t.w) {
        if (w.vy > 0 && prevBottom <= t.top + 0.5 && bottom >= t.top) {
          w.cubeY = t.top - supportY(w.cubeAngle);
          w.offset = Math.max(-t.w / 2, Math.min(t.w / 2, w.cubeX + half - pivotX(t)));
          w.vx *= 0.22;
          w.vy = 0;
          w.cubeSpin *= 0.72;
          w.slide = w.vx * 0.42;
          w.score += 1;
          w.landed = 1;
          w.camTarget = t.x + t.w - START_RIGHT;
          w.phase = 'scroll';
          return;
        }
        if (w.cubeY > t.top + CUBE) { w.vx = 0; w.phase = 'drop'; return; }
      }
      if (w.cubeY > H + CUBE) { w.phase = 'over'; w.over = true; }
      break;
    }
    case 'scroll': {
      // Preserve horizontal momentum on landing so the cube visibly skids across the tower top.
      w.offset += w.slide * dt;
      w.cubeX += w.slide * dt;
      w.slide *= Math.exp(-2.2 * dt);
      w.cubeAngle += w.cubeSpin * dt;
      w.cubeSpin *= Math.exp(-3.5 * dt);
      w.cubeY = w.towers[w.landed].top - (CUBE / 2) * Math.abs(Math.sin(rad(w.cubeAngle)));
      const landingTower = w.towers[w.landed];
      if (w.offset > landingTower.w / 2 + CUBE * 0.35 || w.offset < -landingTower.w / 2 - CUBE * 0.35) {
        w.vy = 0;
        w.phase = 'drop';
        break;
      }
      w.cam = Math.min(w.camTarget, w.cam + SCROLL * dt);
      if (w.cam >= w.camTarget) {
        for (let k = 0; k < w.landed; k++) {
          w.towers.shift();
          w.towers.push(nextTower(w.towers[w.towers.length - 1], rng, w.score));
        }
        w.fallen = [];
        w.angle = 0;
        w.vel = START_VEL;
        w.cubeSpin = 0;
        w.phase = 'wait';
        seat(w);
      }
      break;
    }
    case 'drop':
      w.vy += GRAVITY * dt;
      w.cubeX += w.vx * dt;
      w.cubeY += w.vy * dt;
      w.cubeAngle += w.cubeSpin * dt;
      w.cubeSpin *= Math.exp(-0.35 * dt);
      if (w.cubeY > H + CUBE) { w.phase = 'over'; w.over = true; }
      break;
  }
}
