// The clocks that stop exec's launch: stall, wall and the cancel signal (#423).
import type * as exec from './exec.ts';

// What stopped a launch.
export type Stop = 'stall' | 'wall' | 'cancel';

// A launch's clocks: the stall clock, which output re-arms, and which re-arms for what is left of stallMs from the last
// activity onIdle saw (Q2 A); the wall clock; and the cancel signal. A failed onIdle saw none.
export function startClocks({ stallMs, wallMs, signal, onIdle }: exec.LaunchOptions, stop: (why: Stop) => void) {
  let lastOutput = Date.now();
  let running = true;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const checkStall = async (stall: number) => {
    let lastActivity = lastOutput;
    if (Date.now() - lastActivity >= stall && onIdle) {
      const seen = await Promise.resolve()
        .then(onIdle)
        .catch(() => null);
      lastActivity = Math.max(lastOutput, seen ?? 0);
    }
    const left = stall - (Date.now() - lastActivity);
    if (!running) return;
    if (left > 0) stallTimer = setTimeout(() => void checkStall(stall), left);
    else stop('stall');
  };
  if (stallMs) stallTimer = setTimeout(() => void checkStall(stallMs), stallMs);
  const wallTimer = wallMs ? setTimeout(() => stop('wall'), wallMs) : undefined;
  const cancel = () => stop('cancel');
  if (signal?.aborted) queueMicrotask(cancel);
  else signal?.addEventListener('abort', cancel, { once: true });
  return {
    touch: () => (lastOutput = Date.now()),
    stop: () => {
      running = false;
      clearTimeout(stallTimer);
      clearTimeout(wallTimer);
      signal?.removeEventListener('abort', cancel);
    },
  };
}
