import test from 'node:test';
import assert from 'node:assert/strict';
import { createLaunchInputBuffer } from '../src/qubo/launch-input.ts';
import { CUBE, H, createWorld, launch, pivotX, step, towerLen } from '../src/qubo/engine.ts';

function landingWorld(offset: number) {
  const world = createWorld(() => 0.5);
  world.phase = 'scroll';
  world.landed = 1;
  world.offset = offset;
  world.landingAge = 0.1;
  world.angle = 12;
  world.vel = 8;
  return world;
}

test('a tap buffered during rescue waits until the same-platform landing', () => {
  const buffer = createLaunchInputBuffer();
  buffer.queue(100, 700, { skipRearCornerHop: true });
  assert.equal(buffer.isReady(200, 'rescue'), false);
  assert.equal(buffer.isReady(300, 'scroll'), true);
  assert.deepEqual(buffer.getLaunchOptions(), { skipRearCornerHop: true });
});

test('a rescue tap is not released while the rescue arc is still in progress', () => {
  const buffer = createLaunchInputBuffer();
  buffer.queue(100, 700, { skipRearCornerHop: true });
  assert.equal(buffer.isReady(250, 'rescue'), false);
  assert.equal(buffer.isReady(300, 'drop'), false);
});

test('an expired rescue tap is discarded', () => {
  const buffer = createLaunchInputBuffer();
  buffer.queue(100, 700, { skipRearCornerHop: true });
  assert.equal(buffer.isReady(801, 'scroll'), false);
  assert.deepEqual(buffer.getLaunchOptions(), {});
});

test('a normal centred landing still launches normally', () => {
  const world = landingWorld(0);
  launch(world);
  assert.equal(world.phase, 'air');
});

test('a normal quick rear-edge tap retains the existing rescue behaviour', () => {
  const world = landingWorld(-10);
  launch(world);
  assert.equal(world.phase, 'rescue');
});

test('a buffered second tap at the rear edge launches forward instead of repeating rescue', () => {
  const world = landingWorld(-10);
  launch(world, { skipRearCornerHop: true });
  assert.equal(world.phase, 'air');
});

test('the first tap after a rescue landing is a forward launch even at the rear edge', () => {
  const world = createWorld(() => 0.5);
  const tower = world.towers[world.landed];
  world.phase = 'rescue';
  world.rescueInPlace = true;
  world.angle = 0;
  world.vel = 0;
  world.vx = 0;
  world.vy = 120;
  world.cubeAngle = 0;
  world.cubeSpin = 0;
  world.cubeX = pivotX(tower) - CUBE / 2;
  world.cubeY = H - towerLen(tower) - CUBE / 2 - 1.5;

  step(world, 1 / 60);
  assert.equal(world.phase, 'scroll');
  assert.equal(world.landingAge, 0.36);

  world.offset = -10;
  launch(world);
  assert.equal(world.phase, 'air');
});
