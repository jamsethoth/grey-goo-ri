// Spawned by the run tests over IPC: another gg process that takes the repo lock, commits on HEAD of `worktree` with
// plumbing (leaving the index alone), appends `run_start` for run `run`, reports its commit and holds the lock until
// told to release it. Told to, it appends `run_end` while it still holds the lock, so a write that waited on the lock
// sees that Event, and one that ran while it was held does not.
// The test runner also loads this file with no arguments, where it does nothing.
import * as events from '../../lib/events.ts';
import * as locks from '../../lib/locks.ts';
import * as sqlite from '../../lib/sqlite.ts';
import * as gitShell from './git-shell.ts';

const [commonDir, worktree, run] = process.argv.slice(2);
if (commonDir && worktree) {
  const handle = await locks.acquire(commonDir, 'repo');
  const parent = gitShell.sh(worktree, 'rev-parse', 'HEAD');
  const sha = gitShell.sh(worktree, 'commit-tree', `${parent}^{tree}`, '-p', parent, '-m', 'child commit');
  gitShell.sh(worktree, 'update-ref', 'HEAD', sha, parent);
  const log = events.eventLog(commonDir, { run });
  log('run_start');
  const released = new Promise((resolve) => process.once('message', resolve));
  process.send?.({ sha });
  await released;
  log('run_end');
  await locks.release(handle);
  sqlite.close(commonDir);
  process.disconnect?.();
}
