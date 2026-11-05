// The golden Execution's git writes behind the repo lock: another holder that contends for it, and the orchestrator's
// locked git the writes queue on.
import * as locks from '../../lib/locks.ts';
import * as run from '../../lib/run.ts';
import type * as runContext from '../../lib/run-context.ts';
import type * as golden from './golden.ts';

type GoldenFixture = golden.GoldenFixture;

// Another holder takes the repo lock at the first lock attempt of the Execution's locks after `arm()`, so that attempt
// fails and waits; at the next attempt `during()` runs and the lock is released, and the waiting git write goes ahead
// behind a contended lock.
export function contendRepoLock(fixture: GoldenFixture, during: () => Promise<unknown>) {
  const { commonDir } = fixture;
  const contention: { state: 'idle' | 'armed' | 'holding' | 'released'; held: locks.LockHandle | null } = {
    state: 'idle',
    held: null,
  };
  fixture.options.deps.locks = locks.createLocks({
    wrapAttempt: async (lock, attempt) => {
      if (lock.commonDir !== commonDir || lock.name !== 'repo') return attempt();
      if (contention.state === 'armed') {
        contention.state = 'holding';
        contention.held = await attempt();
        return null;
      }
      if (contention.state === 'holding') {
        contention.state = 'released';
        await during();
        await locks.release(contention.held as locks.LockHandle);
      }
      return attempt();
    },
  });
  return {
    arm: () => {
      contention.state = 'armed';
    },
    state: () => contention.state,
  };
}

type Verb = 'writeTree' | 'commitStaged' | 'push';

// Puts the golden Execution on the orchestrator's locked git; `after(verb, n)` runs after the nth raw call of a verb.
// Returns the raw calls counted so far, by verb.
export function onLockedGit(fixture: GoldenFixture, after: (verb: Verb, count: number) => void) {
  const counts: Partial<Record<Verb, number>> = {};
  const git = fixture.options.deps.git;
  const counted =
    (verb: Verb) =>
    async (...args: unknown[]) => {
      const result = await (git[verb] as (...given: unknown[]) => Promise<unknown>)(...args);
      counts[verb] = (counts[verb] ?? 0) + 1;
      after(verb, counts[verb]);
      return result;
    };
  const raw = { writeTree: counted('writeTree'), commitStaged: counted('commitStaged'), push: counted('push') };
  fixture.options.deps.git = run.lockedGit({ ...git, ...raw } as runContext.RunGit, fixture.commonDir, {
    locks: fixture.options.deps.locks,
  });
  return counts;
}
