// An Integrity Violation's rollback interrupted at its reset: the git a case runs it with.
import * as interpreter from '../../lib/interpreter.ts';
import type * as runContext from '../../lib/run-context.ts';

type RunGit = runContext.RunGit;

// `git` whose resetTo crashes gg before the reset, or once the reset is done when `after` is set.
export const crashingReset = (git: RunGit, { after = false } = {}): RunGit => ({
  ...git,
  resetTo: async (...args) => {
    if (after) await git.resetTo(...args);
    throw new interpreter.CrashError(after ? 'crash after reset' : 'crash before reset');
  },
});

// `git` whose resetTo notes that the reset ran, for a crash point that comes after it.
export function notedReset(git: RunGit): { git: RunGit; reset: () => boolean } {
  const noted = { reset: false };
  return {
    git: {
      ...git,
      resetTo: async (...args) => {
        await git.resetTo(...args);
        noted.reset = true;
      },
    },
    reset: () => noted.reset,
  };
}
