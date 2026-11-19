import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceAdaptive, getInitialRenderScale } from '../src/qubo/device-adaptive.ts';

test('caps high-DPI rendering on older Android WebViews', () => {
  assert.equal(getInitialRenderScale({
    devicePixelRatio: 3,
    userAgent: 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/113.0.0.0 Mobile Safari/537.36',
    hardwareConcurrency: 8,
    deviceMemory: 8,
  }), 1.5);
});

test('uses a lower initial scale for constrained devices', () => {
  assert.equal(getInitialRenderScale({
    devicePixelRatio: 3,
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0.0.0 Mobile',
    hardwareConcurrency: 2,
    deviceMemory: 2,
  }), 1);
  assert.equal(getInitialRenderScale({
    devicePixelRatio: 3,
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0.0.0 Mobile',
    hardwareConcurrency: 4,
    deviceMemory: 4,
  }), 1.25);
});

test('keeps rendering scale within the device pixel ratio and desktop cap', () => {
  assert.equal(getInitialRenderScale({
    devicePixelRatio: 1,
    userAgent: 'Desktop Chrome/130',
    hardwareConcurrency: 16,
    deviceMemory: 16,
  }), 1);
  assert.equal(getInitialRenderScale({
    devicePixelRatio: 3,
    userAgent: 'Desktop Chrome/130',
    hardwareConcurrency: 16,
    deviceMemory: 16,
  }), 2);
});

test('reduces canvas resolution after sustained slow frame windows', () => {
  const adaptive = createDeviceAdaptive({
    devicePixelRatio: 3,
    userAgent: 'Mozilla/5.0 (Linux; Android 12) Chrome/113.0.0.0 Mobile',
    hardwareConcurrency: 8,
    deviceMemory: 8,
  } as Navigator);
  assert.equal(adaptive.getRenderScale(), 1.5);
  let changed = false;
  for (let i = 0; i < 120; i++) changed = adaptive.observeFrame(0.025) || changed;
  assert.equal(changed, true);
  assert.equal(adaptive.getRenderScale(), 1.25);
  assert.deepEqual(adaptive.getSettings(), {
    enabled: true,
    baseRenderScale: 1.5,
    currentRenderScale: 1.25,
    adjustmentCount: 1,
  });
});

test('recovers quality gradually after sustained stable frame pacing', () => {
  const adaptive = createDeviceAdaptive({
    devicePixelRatio: 3,
    userAgent: 'Mozilla/5.0 (Linux; Android 12) Chrome/113.0.0.0 Mobile',
    hardwareConcurrency: 8,
    deviceMemory: 8,
  } as Navigator);
  for (let i = 0; i < 120; i++) adaptive.observeFrame(0.025);
  assert.equal(adaptive.getRenderScale(), 1.25);
  let changed = false;
  for (let i = 0; i < 360; i++) changed = adaptive.observeFrame(1 / 60) || changed;
  assert.equal(changed, true);
  assert.equal(adaptive.getRenderScale(), 1.35);
  assert.equal(adaptive.getSettings().adjustmentCount, 2);
});
