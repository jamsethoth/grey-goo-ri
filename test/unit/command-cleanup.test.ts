import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as commandCleanup from '../../lib/command-cleanup.ts';
type ProcessRow = commandCleanup.ProcessRow;
type Seen = commandCleanup.Seen;

// `ps -e -o pid=,ppid=,lstart=` under TZ=UTC LC_ALL=C, captured from a real Linux listing.
const PS_LISTING = readFileSync(new URL('../fixtures/ps-listing.txt', import.meta.url), 'utf8');
const SELF = 9000; // the process doing the cleanup, as gg's own pid
const ROOT = 100;
const seenOf = (...rows: ProcessRow[]): Seen => new Map(rows.map((row) => [row[0], row]));

test('parseListing reads each ps row as its pid, parent pid and start time', () => {
  const listing = commandCleanup.parseListing({ code: 0, stdout: PS_LISTING, stderr: '' });
  assert.equal(listing.error, undefined);
  assert.deepEqual(listing.processes.slice(0, 3), [
    [1, 0, 'Wed Nov 4 05:29:23 2026'],
    [2, 1, 'Wed Nov 4 05:29:23 2026'],
    [10, 2, 'Wed Nov 4 05:29:23 2026'],
  ]);
  assert.equal(listing.processes.length, 6);
});

test('parseListing drops a header, a blank line and a row without a start time', () => {
  const stdout = `  PID  PPID STARTED\n\n12 3\n${PS_LISTING}`;
  const listing = commandCleanup.parseListing({ code: 0, stdout, stderr: '' });
  assert.deepEqual(
    listing.processes.map(([pid]) => pid),
    [1, 2, 10, 50, 84, 91],
  );
});

test('parseListing fails a listing with no rows, though ps exited 0', () => {
  const listing = commandCleanup.parseListing({ code: 0, stdout: '\n', stderr: '' });
  assert.deepEqual(listing, { processes: [], error: 'process snapshot failed (exit 0):' });
});

test('parseListing fails a listing that exited non-zero, naming the exit and stderr, though it has rows', () => {
  const listing = commandCleanup.parseListing({ code: 1, stdout: PS_LISTING, stderr: 'ps: bad option\n' });
  assert.equal(listing.error, 'process snapshot failed (exit 1): ps: bad option');
});

test('parseListing names a listing whose ps did not start', () => {
  const listing = commandCleanup.parseListing({ code: null, stdout: '', stderr: 'spawn ps ENOENT' });
  assert.equal(listing.error, 'process snapshot failed (did not start): spawn ps ENOENT');
});

test('growTree adds a grandchild through its parent, whichever order the rows come in', () => {
  const tree = new Set([ROOT]);
  const joined: number[] = [];
  const rows: ProcessRow[] = [
    [102, 101, 't'],
    [7, 1, 't'],
    [101, ROOT, 't'],
  ];
  commandCleanup.growTree(tree, rows, SELF, ([pid]) => joined.push(pid));
  assert.deepEqual([...tree], [ROOT, 101, 102]);
  assert.deepEqual(joined, [101, 102]);
});

test('growTree never adds selfPid, nor what it starts', () => {
  const tree = new Set([ROOT]);
  const rows: ProcessRow[] = [
    [SELF, ROOT, 't'],
    [9001, SELF, 't'],
    [101, ROOT, 't'],
  ];
  commandCleanup.growTree(tree, rows, SELF);
  assert.deepEqual([...tree], [ROOT, 101]);
});

test('observe records a new descendant with its start time, and no other process', () => {
  const seen: Seen = new Map();
  commandCleanup.observe(
    seen,
    ROOT,
    [
      [ROOT, 1, 't0'],
      [101, ROOT, 't1'],
      [7, 1, 't2'],
    ],
    SELF,
  );
  assert.deepEqual([...seen], [[101, [101, ROOT, 't1']]]);
});

test('observe forgets a seen pid no longer listed, since its pid may come to name another process', () => {
  const seen = seenOf([101, ROOT, 't1'], [102, 101, 't2']);
  commandCleanup.observe(seen, ROOT, [[101, ROOT, 't1']], SELF);
  assert.deepEqual([...seen.keys()], [101]);
});

test('observe keeps a descendant reparented after its parent exits, and records what it starts', () => {
  const seen = seenOf([101, ROOT, 't1'], [102, 101, 't2']);
  commandCleanup.observe(
    seen,
    ROOT,
    [
      [102, 1, 't2'],
      [103, 102, 't3'],
    ],
    SELF,
  );
  assert.deepEqual([...seen.keys()], [102, 103]);
  assert.deepEqual(seen.get(102), [102, 101, 't2'], 'the row it was first seen with is kept');
});

test('killPlan kills the root, each seen descendant still listed with its start time, and what they started', () => {
  const seen = seenOf([101, ROOT, 't1']);
  const listing = {
    processes: [
      [ROOT, 1, 't0'],
      [101, 1, 't1'],
      [102, 101, 't2'],
      [7, 1, 't7'],
      [SELF, ROOT, 't9'],
    ] as ProcessRow[],
    error: undefined,
  };
  assert.deepEqual(commandCleanup.killPlan(ROOT, seen, listing, SELF), { kill: [ROOT, 101, 102], survivors: [] });
});

test('killPlan leaves alone a seen pid listed with another start time, and what it started, and names it', () => {
  const seen = seenOf([101, ROOT, 't1']);
  const listing = {
    processes: [
      [ROOT, 1, 't0'],
      [101, 1, 'reused'],
      [102, 101, 't2'],
    ] as ProcessRow[],
    error: undefined,
  };
  assert.deepEqual(commandCleanup.killPlan(ROOT, seen, listing, SELF), {
    kill: [ROOT],
    survivors: [{ pid: 101, error: 'not verified gone: its pid now has another start time' }],
  });
});

test('killPlan neither kills nor names a seen pid no longer listed', () => {
  const seen = seenOf([101, ROOT, 't1']);
  const listing = {
    processes: [
      [ROOT, 1, 't0'],
      [7, 1, 't7'],
    ] as ProcessRow[],
    error: undefined,
  };
  assert.deepEqual(commandCleanup.killPlan(ROOT, seen, listing, SELF), { kill: [ROOT], survivors: [] });
});

test('killPlan on a failed listing kills the root and names every seen pid unverified, the root once', () => {
  const error = 'process snapshot failed (exit 1): ps: bad option';
  const seen = seenOf([ROOT, 1, 't0'], [101, ROOT, 't1'], [102, 101, 't2']);
  assert.deepEqual(commandCleanup.killPlan(ROOT, seen, { processes: [], error }, SELF), {
    kill: [ROOT],
    survivors: [
      { pid: 101, error: `not verified gone: ${error}` },
      { pid: 102, error: `not verified gone: ${error}` },
    ],
  });
});

test('leftoverPids drops a member no longer in the process list, which is still exiting', () => {
  const entries = [{ pid: 201, parentPid: ROOT, exe: 'node.exe' }];
  assert.deepEqual(commandCleanup.leftoverPids([201, 202], entries, ROOT), [201]);
});

test('leftoverPids names only members of the job, in member order, not every running process', () => {
  const entries = [
    { pid: 7, parentPid: 1, exe: 'explorer.exe' },
    { pid: 202, parentPid: 201, exe: 'node.exe' },
    { pid: 201, parentPid: ROOT, exe: 'node.exe' },
  ];
  assert.deepEqual(commandCleanup.leftoverPids([201, 202], entries, ROOT), [201, 202]);
});

test("leftoverPids drops the command's own console host, but not another conhost.exe", () => {
  const entries = [
    { pid: 201, parentPid: ROOT, exe: 'Conhost.exe' },
    { pid: 202, parentPid: 300, exe: 'conhost.exe' },
  ];
  assert.deepEqual(commandCleanup.leftoverPids([201, 202], entries, ROOT), [202]);
});

test('lib/command-cleanup.ts imports nothing, so its decisions do no I/O', () => {
  const anyImport = /^import\b/m;
  assert.match("// one\nimport { dlopen } from 'node:ffi';", anyImport, 'an import is seen');
  const source = readFileSync(new URL('../../lib/command-cleanup.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, anyImport);
});
