// Time as gg reads it: the wall clock at the entry point, a test's own clock in a test. Its own module so the locks,
// which the Run context's imports reach, can default to it without an import cycle.

// `every(ms, fn)` calls fn every ms until the stop function it returns is called.
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  every(ms: number, tick: () => void): () => void;
}

export const WALL_CLOCK: Clock = {
  now: Date.now,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  every: (ms, tick) => {
    const timer = setInterval(tick, ms);
    return () => clearInterval(timer);
  },
};
