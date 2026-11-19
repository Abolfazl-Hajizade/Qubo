export type LaunchBufferPhase = 'wait' | 'air' | 'scroll' | 'rescue' | 'drop' | 'over';

export interface BufferedLaunchOptions {
  skipRearCornerHop?: boolean;
}

/** Holds a tap made during a rescue arc until the cube is safely back on its platform. */
export function createLaunchInputBuffer() {
  let deadline = 0;
  let options: BufferedLaunchOptions = {};

  return {
    queue(now: number, durationMs: number, nextOptions: BufferedLaunchOptions = {}) {
      deadline = now + durationMs;
      options = { ...nextOptions };
    },
    isReady(now: number, phase: LaunchBufferPhase) {
      if (!deadline) return false;
      if (now > deadline) {
        deadline = 0;
        options = {};
        return false;
      }
      return phase === 'scroll';
    },
    getLaunchOptions(): BufferedLaunchOptions {
      return { ...options };
    },
    clear() {
      deadline = 0;
      options = {};
    },
  };
}
