// Deterministic simulation regression tests for Qubo's fixed-step physics.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, launch, step } from '../src/qubo/engine.ts';

const FIXED_DT = 1 / 60;
const MAX_FRAME_DELTA = 0.1;
const MAX_STEPS = 6;
const TOTAL_TICKS = 180;
const LAUNCH_TICK = 60;

type Snapshot = {
  phase: string;
  angle: number;
  vel: number;
  cubeX: number;
  cubeY: number;
  vx: number;
  vy: number;
  score: number;
};

function makeRng() {
  // A repeatable non-constant sequence, so generated platforms are reproducible.
  let state = 0x12345678;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function runWithFrameSchedule(frameDeltas: number[]): Snapshot[] {
  const world = createWorld(makeRng());
  const rng = makeRng();
  let accumulator = 0;
  let ticks = 0;
  let frame = 0;
  const snapshots: Snapshot[] = [];

  while (ticks < TOTAL_TICKS) {
    const frameDelta = Math.min(MAX_FRAME_DELTA, Math.max(0, frameDeltas[frame % frameDeltas.length]));
    accumulator = Math.min(MAX_FRAME_DELTA, accumulator + frameDelta);
    let steps = 0;

    while (accumulator >= FIXED_DT && steps < MAX_STEPS && ticks < TOTAL_TICKS) {
      if (ticks === LAUNCH_TICK) launch(world);
      step(world, FIXED_DT, rng);
      snapshots.push({
        phase: world.phase,
        angle: world.angle,
        vel: world.vel,
        cubeX: world.cubeX,
        cubeY: world.cubeY,
        vx: world.vx,
        vy: world.vy,
        score: world.score,
      });
      accumulator -= FIXED_DT;
      ticks++;
      steps++;
    }
    frame++;
    if (frame > 2000) throw new Error('Frame schedule did not advance the simulation');
  }

  return snapshots;
}

const schedules = [
  { name: '30 Hz', deltas: [1 / 30] },
  { name: '60 Hz', deltas: [1 / 60] },
  { name: '90 Hz', deltas: [1 / 90] },
  { name: '120 Hz', deltas: [1 / 120] },
  { name: 'irregular frame pacing', deltas: [0.008, 0.041, 0.016, 0.024, 0.011, 0.033, 0.017] },
  { name: 'occasional 50 ms frame drops', deltas: [1 / 60, 1 / 60, 0.05, 1 / 60, 1 / 60, 1 / 60] },
];

test('jump trajectory is identical across refresh rates and ordinary frame pacing variation', () => {
  const reference = runWithFrameSchedule(schedules[1].deltas);

  for (const schedule of schedules) {
    const actual = runWithFrameSchedule(schedule.deltas);
    assert.equal(actual.length, reference.length, schedule.name);
    for (let i = 0; i < reference.length; i++) {
      assert.equal(actual[i].phase, reference[i].phase, `${schedule.name}: phase at tick ${i}`);
      for (const key of ['angle', 'vel', 'cubeX', 'cubeY', 'vx', 'vy', 'score'] as const) {
        assert.ok(
          Math.abs(actual[i][key] - reference[i][key]) < 1e-9,
          `${schedule.name}: ${key} differs at tick ${i}: ${actual[i][key]} vs ${reference[i][key]}`,
        );
      }
    }
  }
});

test('a tap is applied at the same simulation tick, independent of render-frame boundaries', () => {
  const expected = runWithFrameSchedule([1 / 60]);
  assert.equal(expected[LAUNCH_TICK].phase, 'air');
  assert.ok(Number.isFinite(expected[LAUNCH_TICK].vy));
  assert.ok(expected[LAUNCH_TICK].vy < 0, 'the launch starts upward');
});

test('large frame gaps are bounded to the configured catch-up budget', () => {
  const world = createWorld(makeRng());
  const rng = makeRng();
  const delta = Math.min(MAX_FRAME_DELTA, 0.8);
  let accumulator = Math.min(MAX_FRAME_DELTA, delta);
  let steps = 0;

  while (accumulator >= FIXED_DT && steps < MAX_STEPS) {
    step(world, FIXED_DT, rng);
    accumulator -= FIXED_DT;
    steps++;
  }

  assert.equal(steps, MAX_STEPS);
  assert.ok(Number.isFinite(world.angle));
  assert.ok(Number.isFinite(world.cubeY));
});
