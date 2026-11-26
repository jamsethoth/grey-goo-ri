// lib/exec.ts's contract on Windows for the thread its watcher takes periodic snapshots on (#531 D1 A): its lifetime is
// its command's, so every path that answers for a command has ended the thread first. Each case runs its command
// until the thread has answered one snapshot, then ends it the way its row names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { Worker } from 'node:worker_threads';
import * as exec from '../../../lib/exec.ts';
import * as gitBash from '../../support/git-bash.ts';
import * as manualTimers from '../../support/manual-timers.ts';
import * as options from '../../support/shell-case-options.ts';

const scratch = mkdtempSync(join(tmpdir(), 'gg-snapshot-thread-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const { WIN_CASE } = options;
const { launch, runShell } = exec.createExec();

// Each snapshot thread started while it watches, and whether it has exited; firstAnswer once one has answered.
function threads() {
  const started: { exited: boolean }[] = [];
  let answered = () => {};
  const firstAnswer = new Promise<void>((resolve) => (answered = resolve));
  const onWorker = (worker: Worker) => {
    const thread = { exited: false };
    started.push(thread);
    worker.on('message', () => answered());
    worker.on('exit', () => (thread.exited = true));
  };
  process.on('worker', onWorker);
  return {
    firstAnswer,
    atAnswer: () => {
      process.off('worker', onWorker);
      return { started: started.length, running: started.filter(({ exited }) => !exited).length };
    },
  };
}

const waitFor = (go: string) => `until [ -e ${go.split(sep).join('/')} ]; do sleep 0.1; done`;
const IDLE_NODE = ['-e', 'setInterval(() => {}, 1000)'];

// A path that answers for a command, by how the command ends once the thread has answered: the go file it waits on
// is written, or the stop the row names comes.
type Path = (go: string, answered: Promise<void>) => Promise<unknown>;
const PATHS: [string, Path][] = [
  ['a launch that exits', (go) => launch({ command: gitBash.gitBash(), args: ['-c', waitFor(go)] })],
  [
    'a launch its wall clock stops',
    (_go, answered) => {
      const held = new AbortController();
      void answered.then(() => held.abort());
      return launch({ command: process.execPath, args: IDLE_NODE, wallMs: 1, testHooks: { signal: held.signal } });
    },
  ],
  [
    'a launch that is cancelled',
    (_go, answered) => {
      const cancel = new AbortController();
      void answered.then(() => cancel.abort());
      return launch({ command: process.execPath, args: IDLE_NODE, signal: cancel.signal });
    },
  ],
  ['a Check that exits', (go) => runShell(`"${gitBash.gitBash()}" -c "${waitFor(go)}"`)],
  [
    'a Check that times out',
    (_go, answered) => {
      const timers = manualTimers.manualTimers();
      void answered.then(() => timers.tick(1000));
      return runShell(`"${gitBash.gitBash()}" -c "sleep 60"`, { timeoutMs: 1000, testHooks: { timers } });
    },
  ],
];

for (const [name, run] of PATHS)
  test(`${name} ends its watcher's snapshot thread before it answers`, WIN_CASE, async () => {
    const go = join(scratch, `${name.replaceAll(' ', '-')}.go`);
    const watched = threads();
    void watched.firstAnswer.then(() => writeFileSync(go, ''));
    await run(go, watched.firstAnswer);
    assert.deepEqual(watched.atAnswer(), { started: 1, running: 0 });
  });
