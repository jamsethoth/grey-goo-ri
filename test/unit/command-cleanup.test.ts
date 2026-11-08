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
  commandCleanup.growTree(tree, rows, SELF, { onJoin: ([pid]) => joined.push(pid) });
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

// A Windows snapshot's rows, and each process's start as a FILETIME; a pid with no start reads as gone.
const entryOf = (pid: number, parentPid: number): commandCleanup.ProcessEntry => ({ pid, parentPid, exe: 'node.exe' });
const startsOf = (starts: Record<number, bigint>) => (pid: number) => starts[pid] ?? null;

test("linkedPids leaves out an older process whose parent pid is the shell's, reused", () => {
  const entries = [entryOf(77, ROOT), entryOf(101, ROOT), entryOf(102, 101)];
  // 101 started in the shell's own tick, which a FILETIME read at tick granularity gives; 77 started before the shell
  const starts = startsOf({ 77: 10n, [ROOT]: 20n, 101: 20n, 102: 30n });
  assert.deepEqual(commandCleanup.linkedPids(ROOT, entries, SELF, starts), [101, 102]);
});

test('linkedPids leaves out an older process under a reused descendant pid, and what that one started', () => {
  // 55 started before 101 took its parent's pid; 56 is 55's own child, younger than both
  const entries = [entryOf(101, ROOT), entryOf(55, 101), entryOf(56, 55)];
  const starts = startsOf({ [ROOT]: 20n, 55: 25n, 101: 30n, 56: 40n });
  assert.deepEqual(commandCleanup.linkedPids(ROOT, entries, SELF, starts), [101]);
});

test('linkedPids leaves out a process whose start cannot be read, and what it started', () => {
  const entries = [entryOf(101, ROOT), entryOf(103, ROOT), entryOf(104, 103)];
  const starts = startsOf({ [ROOT]: 20n, 101: 30n, 104: 40n });
  assert.deepEqual(commandCleanup.linkedPids(ROOT, entries, SELF, starts), [101]);
});

test('linkedPids never adds selfPid, nor what it starts', () => {
  const entries = [entryOf(SELF, ROOT), entryOf(9001, SELF), entryOf(101, ROOT)];
  const starts = startsOf({ [ROOT]: 20n, [SELF]: 30n, 9001: 40n, 101: 30n });
  assert.deepEqual(commandCleanup.linkedPids(ROOT, entries, SELF, starts), [101]);
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
    survivors: [
      {
        pid: 101,
        created: 'reused',
        commandLine: null,
        error: 'not verified gone: its pid now has another start time',
      },
    ],
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
      { pid: 101, created: 't1', commandLine: null, error: `not verified gone: ${error}` },
      { pid: 102, created: 't2', commandLine: null, error: `not verified gone: ${error}` },
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

test('strayProcesses names the members of a stage job still running, less the process holding it', () => {
  const held = { pid: SELF, parentPid: 1, exe: 'node.exe' };
  const stray = { pid: 201, parentPid: 200, exe: 'node.exe' };
  const other = { pid: 7, parentPid: 1, exe: 'explorer.exe' };
  assert.deepEqual(commandCleanup.strayProcesses([SELF, 201], [held, stray, other], SELF), [stray]);
});

test('strayProcesses drops a member no longer in the process list, which is still exiting', () => {
  const stray = { pid: 201, parentPid: 200, exe: 'node.exe' };
  assert.deepEqual(commandCleanup.strayProcesses([201, 202], [stray], SELF), [stray]);
});

// A console host ends with the last process attached to it, so a host left is never the leak: if something keeps it
// alive, that process is named. Any parent, since a stage's hosts belong to the commands its tests run.
test('strayProcesses drops every console host, whatever started it', () => {
  const host = { pid: 201, parentPid: 300, exe: 'Conhost.exe' };
  assert.deepEqual(commandCleanup.strayProcesses([201], [host], SELF), []);
});

test('lib/command-cleanup.ts imports nothing, so its decisions do no I/O', () => {
  const anyImport = /^import\b/m;
  assert.match("// one\nimport { dlopen } from 'node:ffi';", anyImport, 'an import is seen');
  const source = readFileSync(new URL('../../lib/command-cleanup.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, anyImport);
});

test("parseListing reads a row's process group and command line after its start time", () => {
  const stdout = '  101     1 Fri Nov  6 10:00:00 2026   100 node writer.js --fast\n';
  const listing = commandCleanup.parseListing({ code: 0, stdout, stderr: '' });
  assert.deepEqual(listing.processes, [[101, 1, 'Fri Nov 6 10:00:00 2026', 100, 'node writer.js --fast']]);
});

test('a command that has exited is not in its kill plan, and what its pid now names is left alone', () => {
  const plan = commandCleanup.leftoverPlan(
    ROOT,
    seenOf([101, ROOT, 't1']),
    {
      processes: [
        [ROOT, 1, 'another'],
        [7, ROOT, 't7'],
        [101, 1, 't1'],
      ],
      error: undefined,
    },
    SELF,
  );
  assert.deepEqual(plan.kill, [101]);
});

test('with an unusable listing, a command that has exited has nothing to attempt', () => {
  const plan = commandCleanup.leftoverPlan(ROOT, seenOf([101, ROOT, 't1']), { processes: [], error: 'no ps' }, SELF);
  assert.deepEqual(plan.kill, []);
  assert.deepEqual(
    plan.survivors.map((survivor) => survivor.pid),
    [101],
  );
});

test('leftovers are what the plan kills and what its group still holds, less the command', () => {
  const left = commandCleanup.leftoverRows(
    ROOT,
    { kill: [101], survivors: [] },
    {
      processes: [
        [101, 1, 't1', 7, 'node a.js'],
        [102, 1, 't2', ROOT, 'node b.js'],
        [ROOT, 1, 't0', ROOT, 'sh'],
        [103, 1, 't3', 7, 'node other.js'],
        [104, 1, 't4', ROOT, '[node] <defunct>'],
      ],
      error: undefined,
    },
  );
  assert.deepEqual(left, [
    { pid: 101, created: 't1', commandLine: 'node a.js' },
    { pid: 102, created: 't2', commandLine: 'node b.js' },
  ]);
});

const JOB = { kind: 'job' } as const;
const SURVIVOR = { pid: 9, created: null, commandLine: null, error: 'still here' };

test('cleanupReport: nothing left under a containment gg can check is confirmed', () => {
  assert.deepEqual(commandCleanup.cleanupReport(JOB, { survivors: [], cleanupErrors: [] }), {
    confirmed: true,
    survivors: [],
    reason: null,
    containment: JOB,
  });
  assert.equal(
    commandCleanup.cleanupReport({ kind: 'group', pgid: 7 }, { survivors: [], cleanupErrors: [] }).confirmed,
    true,
  );
});

test('cleanupReport: a survivor leaves it unconfirmed, and says why', () => {
  assert.deepEqual(commandCleanup.cleanupReport(JOB, { survivors: [SURVIVOR], cleanupErrors: [] }), {
    confirmed: false,
    survivors: [SURVIVOR],
    reason: '1 process could not be confirmed gone',
    containment: JOB,
  });
});

test('cleanupReport: a cleanup error is the reason, with no survivor named', () => {
  const report = commandCleanup.cleanupReport(JOB, { survivors: [], cleanupErrors: ['first', 'second'] });
  assert.equal(report.confirmed, false);
  assert.equal(report.reason, 'first; second');
});

test('cleanupReport: an uncontained command is always unconfirmed', () => {
  const report = commandCleanup.cleanupReport({ kind: 'none' }, { survivors: [], cleanupErrors: [] });
  assert.equal(report.confirmed, false);
  assert.match(report.reason as string, /uncontained/);
});

test('a Check that ran no command names no process and no containment', () => {
  assert.deepEqual(commandCleanup.NO_COMMAND, { confirmed: true, survivors: [] });
});

test('a job is confirmed gone by a later Run: the Run that held it closed its handle', () => {
  assert.equal(
    commandCleanup.confirmedUnder({ kind: 'job' }, () => true),
    true,
  );
});

test('a process group is confirmed gone once it has no member', () => {
  const asked: number[] = [];
  const hasMembers = (pgid: number) => {
    asked.push(pgid);
    return pgid === 41;
  };
  assert.equal(commandCleanup.confirmedUnder({ kind: 'group', pgid: 41 }, hasMembers), false);
  assert.equal(commandCleanup.confirmedUnder({ kind: 'group', pgid: 42 }, hasMembers), true);
  assert.deepEqual(asked, [41, 42]);
});

test('no containment is never confirmed, and a report that names none reads as no containment', () => {
  assert.equal(
    commandCleanup.confirmedUnder({ kind: 'none' }, () => false),
    false,
  );
  assert.equal(
    commandCleanup.confirmedUnder(undefined, () => false),
    false,
  );
});
