// The git the `gg run` fixture gives gg, with one verb failing as git does; `attempts.count` says how often gg
// called it.
import type * as runFixture from './run-fixture.ts';

type FailingVerb = 'ensureWorktree' | 'listWorktrees' | 'currentBranch';

export function failGitVerb(fixture: runFixture.RunFixture, verb: FailingVerb, message: string) {
  const attempts = { count: 0 };
  fixture.options.deps.git = {
    ...fixture.options.deps.git,
    [verb]: async () => {
      attempts.count++;
      throw new Error(message);
    },
  };
  return attempts;
}
