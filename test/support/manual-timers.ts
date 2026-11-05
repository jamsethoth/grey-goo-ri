import type * as exec from '../../lib/exec.ts';

// runShell's timeout timer, moved by the case: tick(ms) moves the time on and fires the armed timer once it is due.
// fired() counts the timeouts that fired.
export function manualTimers() {
  let now = 0;
  let armed: { run: () => void; due: number } | null = null;
  let fired = 0;
  const timers = {
    setTimeout: (run: () => void, ms: number) => (armed = { run, due: now + ms }),
    clearTimeout: (timer: unknown) => {
      if (armed === timer) armed = null;
    },
  } as unknown as exec.Timers;
  return {
    ...timers,
    tick: (ms: number) => {
      now += ms;
      if (!armed || armed.due > now) return;
      const { run } = armed;
      armed = null;
      fired++;
      run();
    },
    fired: () => fired,
  };
}
