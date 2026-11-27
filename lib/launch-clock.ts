// The clocks that stop exec's launch: stall, wall and the cancel signal (#423).
import type * as exec from './exec.ts';

// What stopped a launch.
export type Stop = 'stall' | 'wall' | 'cancel';

// setTimeout fires after 1 ms for a delay past 2147483647 ms (24.8 days), so each limit is capped there (#429 D3 A).
const TIMER_CAP_MS = 2_147_483_647;
const capped = (ms: number | undefined) => ms && Math.min(ms, TIMER_CAP_MS);

// The time and timers the stall and wall clocks run on: the wall clock's, or a test's testHooks.clock, which the case
// moves itself, so no delay of gg's thread changes what it asserts (#531 D2 B).
export interface Clock {
  now: () => number;
  setTimeout: (run: () => void, ms: number) => unknown;
  clearTimeout: (timer: unknown) => void;
}
const WALL_CLOCK: Clock = { now: Date.now, setTimeout, clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout) };

// A launch's clocks: the stall clock, which output re-arms, and which re-arms for what is left of stallMs from the last
// activity onIdle saw (Q2 A); the wall clock; and the cancel signal. A failed onIdle saw none. A test's
// testHooks.signal holds the stall and wall clocks until it aborts (#475).
export function startClocks(options: exec.LaunchOptions, stop: (why: Stop) => void) {
  const { signal, onIdle, testHooks } = options;
  const clock = testHooks?.clock ?? WALL_CLOCK;
  const [stallMs, wallMs] = [capped(options.stallMs), capped(options.wallMs)];
  let lastOutput = clock.now();
  let running = true;
  let stallTimer: unknown;
  let wallTimer: unknown;
  const checkStall = async (stall: number) => {
    let lastActivity = lastOutput;
    if (clock.now() - lastActivity >= stall && onIdle) {
      const seen = await Promise.resolve()
        .then(onIdle)
        .catch(() => null);
      lastActivity = Math.max(lastOutput, seen ?? 0);
    }
    const left = stall - (clock.now() - lastActivity);
    if (!running) return;
    if (left > 0) stallTimer = clock.setTimeout(() => void checkStall(stall), left);
    else stop('stall');
  };
  const arm = () => {
    if (!running) return;
    if (stallMs) stallTimer = clock.setTimeout(() => void checkStall(stallMs), stallMs);
    if (wallMs) wallTimer = clock.setTimeout(() => stop('wall'), wallMs);
  };
  const held = testHooks?.signal;
  if (!held || held.aborted) arm();
  else held.addEventListener('abort', arm, { once: true });
  const cancel = () => stop('cancel');
  if (signal?.aborted) queueMicrotask(cancel);
  else signal?.addEventListener('abort', cancel, { once: true });
  return {
    touch: () => (lastOutput = clock.now()),
    stop: () => {
      running = false;
      clock.clearTimeout(stallTimer);
      clock.clearTimeout(wallTimer);
      signal?.removeEventListener('abort', cancel);
      held?.removeEventListener('abort', arm);
    },
  };
}
