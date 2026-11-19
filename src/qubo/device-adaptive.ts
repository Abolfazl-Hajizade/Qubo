/**
 * Device-adaptive rendering for Qubo.
 *
 * This module only changes the canvas backing resolution. It never changes
 * simulation dt, launch values, collision geometry, scoring, or game rules.
 */
export interface DeviceRenderHints {
  devicePixelRatio: number;
  userAgent: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
}

export function getInitialRenderScale(hints: DeviceRenderHints): number {
  const dpr = Number.isFinite(hints.devicePixelRatio) && hints.devicePixelRatio > 0
    ? hints.devicePixelRatio : 1;
  let cap = 2;

  const android = /Android/i.test(hints.userAgent);
  const chrome = hints.userAgent.match(/(?:Chrome|CriOS)\/(\d+)/i);
  const chromeMajor = chrome ? Number(chrome[1]) : 0;

  // Older Android Telegram WebViews can struggle with large high-DPI canvases.
  if (android) cap = chromeMajor > 0 && chromeMajor <= 120 ? 1.5 : 1.75;

  const cores = hints.hardwareConcurrency;
  const memory = hints.deviceMemory;
  if ((typeof cores === 'number' && cores <= 2) || (typeof memory === 'number' && memory <= 2)) {
    cap = Math.min(cap, 1);
  } else if ((typeof cores === 'number' && cores <= 4) || (typeof memory === 'number' && memory <= 4)) {
    cap = Math.min(cap, 1.25);
  }

  return Math.max(1, Math.min(dpr, cap));
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

export function createDeviceAdaptive(hints: Navigator = navigator) {
  const nav = hints as Navigator & { deviceMemory?: number };
  const baseScale = getInitialRenderScale({
    devicePixelRatio: window.devicePixelRatio || 1,
    userAgent: nav.userAgent || '',
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
  });
  let renderScale = baseScale;
  let samples: number[] = [];
  let slowWindows = 0;
  let stableWindows = 0;

  return {
    getRenderScale: () => renderScale,
    observeFrame(frameDeltaSeconds: number): boolean {
      if (!Number.isFinite(frameDeltaSeconds) || frameDeltaSeconds <= 0) return false;
      samples.push(frameDeltaSeconds * 1000);
      if (samples.length < 60) return false;

      const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
      const p95 = percentile(samples, 0.95);
      samples = [];

      if (average >= 21 || p95 >= 30) {
        slowWindows++;
        stableWindows = 0;
        if (slowWindows >= 2 && renderScale > 1) {
          renderScale = Math.max(1, Math.round((renderScale - 0.25) * 100) / 100);
          slowWindows = 0;
          return true;
        }
      } else if (average <= 18 && p95 <= 21) {
        stableWindows++;
        slowWindows = 0;
        if (stableWindows >= 6 && renderScale < baseScale) {
          renderScale = Math.min(baseScale, Math.round((renderScale + 0.1) * 100) / 100);
          stableWindows = 0;
          return true;
        }
      } else {
        slowWindows = 0;
        stableWindows = 0;
      }
      return false;
    },
  };
}
