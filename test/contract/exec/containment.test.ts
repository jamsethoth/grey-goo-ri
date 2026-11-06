import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as childScripts from '../../support/child-scripts.ts';
import * as processProbe from '../../support/process-probe.ts';
import * as options from '../../support/shell-case-options.ts';

const { pidIn } = processProbe;

// While the shell runs, its job holds the shell, the console host CREATE_NO_WINDOW gave it and the sleeper, all alive,
// so only the console host's name and parent tell it apart.
test('a job names the processes it holds, leaving out the console host of its shell', options.WIN_CASE, async (t) => {
  const containment = await import('../../../lib/containment.ts');
  const kernel32 = containment.openKernel32();
  assert.ok(kernel32, 'node:ffi is unavailable');
  const directory = mkdtempSync(join(tmpdir(), 'gg-containment-'));
  const pidFile = join(directory, 'sleeper.pid');
  const { child, job } = containment.start(
    kernel32,
    childScripts.nodeCommand(t, childScripts.LONG_LIVED, pidFile),
    undefined,
  );
  assert.ok(job, 'the job was not set up');
  // first in, first out: the processes are gone before their directory is removed
  t.after(async () => {
    job.terminate();
    await job.emptied();
    job.close();
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  child.stdout?.resume();
  child.stderr?.resume();
  // a sleeper that never starts fails at the case timeout
  await processProbe.waitFor(() => pidIn(pidFile) > 0, t.signal);
  assert.equal(job.members().length, 3, 'the shell, its console host and the sleeper');
  const ascending = (left: number, right: number) => left - right;
  assert.deepEqual(job.leftovers(child.pid ?? 0).sort(ascending), [child.pid ?? 0, pidIn(pidFile)].sort(ascending));
});
