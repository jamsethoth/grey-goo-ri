// Spawned by the run tests over IPC: another gg process that takes the repo lock, commits on HEAD of `worktree` with
// plumbing (leaving the index alone), appends Events for run `run`, reports its commit and holds the lock until told to
// release it, then reports the time it released.
// The test runner also loads this file with no arguments, where it does nothing.
import * as events from '../../lib/events.mjs';
import { runGit } from '../../lib/git.mjs';
import * as locks from '../../lib/locks.mjs';
import * as record from '../../lib/record.mjs';
const [commonDir, worktree, run] = process.argv.slice(2);
if (commonDir) {
  const git = async (...args) => (await runGit(args, { cwd: worktree })).stdout.trim();
  const handle = await locks.acquire(commonDir, 'repo');
  const parent = await git('rev-parse', 'HEAD');
  const sha = await git('commit-tree', `${parent}^{tree}`, '-p', parent, '-m', 'child commit');
  await git('update-ref', 'HEAD', sha, parent);
  const log = events.eventLog(commonDir, { run });
  log('run_start');
  log('run_end');
  const released = new Promise((resolve) => process.once('message', resolve));
  process.send({ sha });
  await released;
  // Taken before the release, so any commit that waited on the lock is later.
  const releasing = Date.now();
  await locks.release(handle);
  record.close(commonDir);
  process.send({ releasing }, () => process.disconnect());
}
