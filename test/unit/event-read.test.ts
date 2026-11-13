import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as eventRead from '../../lib/event-read.ts';
import * as events from '../../lib/events.ts';
import * as stateDatabase from '../../lib/state-database.ts';
import * as tempDirectory from '../support/temp-directory.ts';

const ROOT = new URL('../../', import.meta.url);

// A row of the events table, as SQLite holds it.
interface EventRow {
  id: number;
  type: string;
  run: string | null;
  execution: string | null;
  ticket: number | null;
  json: string;
}

const COLUMNS = ['type', 'run', 'execution', 'ticket'] as const;

const usage = () => ({ peakContextTokens: 1200, turns: 3, toolCalls: 4, compactions: 0, costUsd: null });
const ACTION_REQUIRED = {
  flow: 'default',
  configHash: 'c0ffee',
  launchProfile: null,
  confinement: null,
  ticket: 7,
  run: 'r1',
  execution: 'e1',
  vertex: 'green',
  visit: 1,
  procedure: 'implement',
  action: 'push',
  recovery: 0,
  attempt: 1,
  durationMs: 1500,
  outcome: 'run-stop',
  direction: 'stop',
  signals: { harnessResult: { status: 'failed', failureClass: 'auth' } },
  rule: { table: 'fixed', row: 'run-stop' },
} satisfies events.EventInput<'action'>;
const TERMINAL_REASON = {
  decidedBy: { vertex: 'publish', visit: 1, action: 'pr-ready', recovery: 0 },
  outcome: 'ok',
  rule: { table: 'passed', row: null },
  text: 'publish visit 1 completed every publish Action.',
} satisfies events.EventInput<'ticket_end'>['terminalReason'];

// One Event of each shape gg writes, every optional field given where it can be: the six Lifecycle types and the two
// Action shapes.
const SHAPES: Record<string, (log: ReturnType<typeof events.eventLog>) => void> = {
  'action agent': (log) =>
    log('action', {
      ...ACTION_REQUIRED,
      agent: true,
      harness: 'fake',
      agentCliVersion: '1.0.0',
      model: 'fake-model',
      effort: 'medium',
      personaHash: 'p1',
      tools: ['Read'],
      sessionInit: { tools: ['Read'] },
      sessionId: 's1',
      sessionLineage: null,
      transcriptPath: 'transcripts/s1.jsonl',
      usage: { cumulative: usage(), delta: usage() },
      exitCode: 1,
      exitSignal: null,
      finalEventSubtype: 'error',
      permissionDenials: [],
      commandsRun: ['npm test'],
      check: 'tests',
      integrityViolations: [],
      retryAfterMs: 0,
      failureClass: 'auth',
      error: 'not logged in',
      cleanup: { confirmed: true, survivors: [] },
    }),
  'action deterministic': (log) =>
    log('action', { ...ACTION_REQUIRED, agent: false, failureClass: 'auth', error: 'git push exited 128' }),
  run_start: (log) => log('run_start', { run: 'r1' }),
  run_end: (log) =>
    log('run_end', { run: 'r1', tickets: [{ ticket: 7, outcome: 'needs-human' }], failureClass: 'auth' }),
  ticket_start: (log) => log('ticket_start', { run: 'r1', execution: 'e1', ticket: 7 }),
  ticket_end: (log) =>
    log('ticket_end', {
      run: 'r1',
      execution: 'e1',
      ticket: 7,
      outcome: 'needs-human',
      diffStats: { files: 2, insertions: 10, deletions: 1, testFiles: 1, testInsertions: 4 },
      terminalReason: TERMINAL_REASON,
      error: 'boom',
      interrupted: { terminal: 'ready-for-qa', terminalReason: TERMINAL_REASON },
    }),
  label_failed: (log) =>
    log('label_failed', { ticket: 7, change: { add: ['gg:state:done'], remove: [] }, error: 'gh 502', run: 'r1' }),
  visit_end: (log) =>
    log('visit_end', {
      run: 'r1',
      execution: 'e1',
      ticket: 7,
      vertex: 'reviewer',
      visit: 2,
      outcome: 'repeat',
      rule: { table: 'passed', row: 1 },
      next: 'senior-dev',
      edge: 'reviewer->senior-dev:repeat',
      count: 1,
      spent: [{ edge: 'reviewer->implementer-fix:changes' }, { vertex: 'implementer-fix' }],
    }),
  config_change: (log) =>
    log('config_change', {
      run: 'r1',
      execution: 'e1',
      ticket: 7,
      vertex: 'publish',
      visit: 1,
      from: 'a'.repeat(64),
      to: 'b'.repeat(64),
    }),
};

const rowsOf = (commonDir: string): EventRow[] =>
  stateDatabase
    .open(commonDir)
    .prepare('SELECT id, type, run, execution, ticket, json FROM events ORDER BY id')
    .all()
    .map((row) => ({ ...row }) as unknown as EventRow);

// A State Database holding one Event of the named shape, and that Event's row.
function written(t: TestContext, shape: string): { commonDir: string; row: EventRow } {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-event-read-');
  SHAPES[shape](events.eventLog(commonDir));
  const [row] = rowsOf(commonDir);
  return { commonDir, row };
}

// Replaces the table's rows with one row: the given columns and JSON text. Returns the row's id.
function plant(commonDir: string, row: Omit<EventRow, 'id'>): number {
  const database = stateDatabase.open(commonDir);
  database.prepare('DELETE FROM events').run();
  const inserted = database
    .prepare('INSERT INTO events (ts, type, run, execution, ticket, json) VALUES (?, ?, ?, ?, ?, ?)')
    .run('2026-11-12T00:00:00.000Z', row.type, row.run, row.execution, row.ticket, row.json);
  return Number(inserted.lastInsertRowid);
}

// The row of `shape` with its JSON edited.
function plantEdited(t: TestContext, shape: string, edit: (json: Record<string, unknown>) => void) {
  const { commonDir, row } = written(t, shape);
  const json = JSON.parse(row.json) as Record<string, unknown>;
  edit(json);
  const id = plant(commonDir, { ...row, json: JSON.stringify(json) });
  return { commonDir, id, type: row.type };
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A refused row is named by its id and type, then what failed.
function assertRefused(commonDir: string, id: number, type: string, reason: RegExp) {
  assert.throws(() => eventRead.readEvents(commonDir), {
    name: 'EventCorruptError',
    message: new RegExp(`^corrupt event ${id} \\(${escaped(type)}\\): ${reason.source}$`),
  });
}

const sourceFiles = (directory: string): string[] =>
  readdirSync(new URL(directory, ROOT), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => `${directory}${file.replaceAll('\\', '/')}`);
const textOf = (file: string) => readFileSync(new URL(file, ROOT), 'utf8');

test('readEvents returns the Events in the order they were appended', (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-event-read-');
  const log = events.eventLog(commonDir);
  const order = ['run_start', 'ticket_start', 'action deterministic', 'action agent', 'ticket_end', 'run_end'];
  for (const shape of order) SHAPES[shape](log);
  const read = eventRead.readEvents(commonDir);
  assert.deepEqual(
    read.map((event) => event.type),
    ['run_start', 'ticket_start', 'action', 'action', 'ticket_end', 'run_end'],
  );
  assert.deepEqual(
    read,
    rowsOf(commonDir).map((row) => JSON.parse(row.json)),
  );
});

test('readEvents on a new State Database returns nothing', (t) => {
  assert.deepEqual(eventRead.readEvents(tempDirectory.stateDatabaseDirectory(t, 'gg-event-read-')), []);
});

test('the shapes read back are every Event shape gg declares', () => {
  assert.deepEqual(Object.keys(SHAPES).sort(), [
    'action agent',
    'action deterministic',
    ...Object.keys(events.LIFECYCLE).sort(),
  ]);
});

for (const shape of Object.keys(SHAPES)) {
  test(`a ${shape} Event reads back unchanged and equal`, (t) => {
    const { commonDir, row } = written(t, shape);
    const [read, ...rest] = eventRead.readEvents(commonDir);
    assert.equal(rest.length, 0);
    assert.deepEqual(read, JSON.parse(row.json));
    assert.equal(JSON.stringify(read), row.json, 'the same keys in the same order');
    assert.deepEqual(eventRead.executionEvents(commonDir, row.execution ?? ''), row.execution ? [read] : []);
  });
}

// SQL that reads the events table, in any case, spacing or quoting, wherever it appears in a source file.
const EVENTS_TABLE_READ = /\bfrom\s+["'`[]?events\b/i;

test('the read census finds a read of the events table in any form', () => {
  const reads = [
    'SELECT * FROM events',
    'select json from events where id = ?',
    'SELECT json FROM\n  events',
    'SELECT json FROM "events"',
    'SELECT 1 FROM `events` LIMIT 1',
    'SELECT 1 FROM [events]',
  ];
  assert.deepEqual(
    reads.filter((sql) => !EVENTS_TABLE_READ.test(sql)),
    [],
  );
  assert.equal(EVENTS_TABLE_READ.test('INSERT INTO events (ts) VALUES (?)'), false, 'an append is no read');
});

test('every read of the events table goes through lib/event-read.ts', () => {
  const sites = ['lib/', 'bin/', 'scripts/', 'test/support/']
    .flatMap(sourceFiles)
    .filter((file) => EVENTS_TABLE_READ.test(textOf(file)));
  assert.ok(sites.includes('lib/event-read.ts'), 'the read module reads the table');
  assert.deepEqual(
    sites.filter((file) => file !== 'lib/event-read.ts'),
    [],
    'a read of the events table outside the checked read',
  );
});

test('a row that is not JSON is refused by name', (t) => {
  const { commonDir, row } = written(t, 'ticket_start');
  const id = plant(commonDir, { ...row, json: '{"type":"ticket_start","run":' });
  assertRefused(commonDir, id, 'ticket_start', /its JSON does not parse: .+/);
});

test('a row whose JSON is not an object is refused by name', (t) => {
  for (const json of ['null', '[]', '"ticket_start"']) {
    const { commonDir, row } = written(t, 'ticket_start');
    assertRefused(commonDir, plant(commonDir, { ...row, json }), 'ticket_start', /its JSON is not an object/);
  }
});

test('a row of another schemaVersion is refused by name', (t) => {
  const { commonDir, id, type } = plantEdited(t, 'run_start', (json) => {
    json.schemaVersion = 3;
  });
  assertRefused(commonDir, id, type, /unknown schemaVersion 3/);
});

test('a row without its time is refused by name', (t) => {
  const { commonDir, id, type } = plantEdited(t, 'run_start', (json) => {
    delete json.time;
  });
  assertRefused(commonDir, id, type, /its time is not a string/);
});

test('a row of a type no Event declares is refused by name', (t) => {
  const { commonDir, row } = written(t, 'ticket_start');
  const json = row.json.replace('"ticket_start"', '"stage_call"');
  const id = plant(commonDir, { ...row, type: 'stage_call', json });
  assertRefused(commonDir, id, 'stage_call', /unknown type stage_call/);
});

for (const [name, agent] of [
  ['missing', undefined],
  ['a string', 'true'],
  ['null', null],
]) {
  test(`an Action Event row whose agent is ${name} is refused by name`, (t) => {
    const { commonDir, id, type } = plantEdited(t, 'action deterministic', (json) => {
      if (agent === undefined) delete json.agent;
      else json.agent = agent;
    });
    assertRefused(commonDir, id, type, /its agent is not true or false/);
  });
}

// Every declared key of every shape, enumerated from the rows gg writes: a saved Event holds them all.
for (const shape of Object.keys(SHAPES)) {
  test(`a ${shape} row missing any declared field is refused by name, field by field`, (t) => {
    const keys = Object.keys(JSON.parse(written(t, shape).row.json) as object).filter(
      (key) => !['schemaVersion', 'time', 'type', 'agent'].includes(key),
    );
    assert.ok(keys.length > 0);
    for (const key of keys) {
      const { commonDir, id, type } = plantEdited(t, shape, (json) => {
        delete json[key];
      });
      assertRefused(commonDir, id, type, new RegExp(`missing field ${key}`));
    }
  });

  test(`a ${shape} row with an undeclared field is refused by name`, (t) => {
    const { commonDir, id, type } = plantEdited(t, shape, (json) => {
      json.owner = 'me';
    });
    assertRefused(commonDir, id, type, /undeclared field owner/);
  });
}

test('a deterministic Action Event row holding an agent field is refused by name', (t) => {
  const { commonDir, id, type } = plantEdited(t, 'action deterministic', (json) => {
    json.harness = 'fake';
  });
  assertRefused(commonDir, id, type, /undeclared field harness/);
});

// The fields gg's own readers use hold a string or null, in every shape that declares them (#350, Q1 B).
const READ_FIELDS = ['failureClass', 'execution', 'run'];
for (const shape of Object.keys(SHAPES)) {
  test(`a ${shape} row whose read fields hold a number is refused by name, field by field`, (t) => {
    const declared = Object.keys(JSON.parse(written(t, shape).row.json) as object).filter((key) =>
      READ_FIELDS.includes(key),
    );
    for (const key of declared) {
      const { commonDir, id, type } = plantEdited(t, shape, (json) => {
        json[key] = 7;
      });
      assertRefused(commonDir, id, type, new RegExp(`its ${key} is not a string or null`));
    }
  });
}

test('a row whose read field is null reads back', (t) => {
  const { commonDir } = plantEdited(t, 'action deterministic', (json) => {
    json.failureClass = null;
  });
  assert.equal(eventRead.readEvents(commonDir).length, 1);
});

for (const column of COLUMNS) {
  test(`a row whose ${column} column differs from its JSON is refused by name`, (t) => {
    const { commonDir, row } = written(t, 'ticket_end');
    const other = { type: 'ticket_start', run: 'r2', execution: 'e2', ticket: 8 }[column];
    const id = plant(commonDir, { ...row, [column]: other });
    const type = column === 'type' ? 'ticket_start' : 'ticket_end';
    assertRefused(
      commonDir,
      id,
      type,
      new RegExp(`its ${column} column is ${JSON.stringify(other)} but its JSON holds .+`),
    );
  });
}

test('a row whose column holds a number where its JSON holds a string says which is which', (t) => {
  const { commonDir, row } = written(t, 'ticket_start');
  const id = plant(commonDir, { ...row, json: row.json.replace('"ticket":7', '"ticket":"7"') });
  assertRefused(commonDir, id, 'ticket_start', /its ticket column is 7 but its JSON holds "7"/);
});

// node:sqlite gives a number no JavaScript number holds as a RangeError for the whole read, before any check.
test('a row whose ticket column holds a number beyond 2^53 is refused by name', (t) => {
  const { commonDir, row } = written(t, 'ticket_start');
  stateDatabase
    .open(commonDir)
    .prepare('UPDATE events SET ticket = ?')
    .run(2n ** 60n);
  assertRefused(commonDir, row.id, 'ticket_start', /its ticket column is "1152921504606846976" but its JSON holds 7/);
});

test('a row whose ticket column holds Infinity is refused by name, and the reason shows it', (t) => {
  const { commonDir, row } = written(t, 'ticket_start');
  stateDatabase.open(commonDir).prepare('UPDATE events SET ticket = ?').run(Infinity);
  assertRefused(commonDir, row.id, 'ticket_start', /its ticket column is "Inf" but its JSON holds 7/);
});

test('a row whose id is beyond 2^53 reads back', (t) => {
  const { commonDir, row } = written(t, 'ticket_start');
  stateDatabase
    .open(commonDir)
    .prepare('UPDATE events SET id = ?')
    .run(2n ** 60n);
  assert.deepEqual(eventRead.readEvents(commonDir), [JSON.parse(row.json)]);
});

test('a refused row whose id is beyond 2^53 is named by its exact id', (t) => {
  const { commonDir, row } = written(t, 'ticket_start');
  stateDatabase
    .open(commonDir)
    .prepare("UPDATE events SET id = ?, json = '{'")
    .run(2n ** 60n + 1n);
  assert.throws(() => eventRead.readEvents(commonDir), {
    name: 'EventCorruptError',
    id: '1152921504606846977',
    message: /^corrupt event 1152921504606846977 \(ticket_start\): its JSON does not parse: /,
  });
  assert.equal(row.type, 'ticket_start');
});

test('rows are read in the order they were appended when an id is beyond 2^53', (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-event-read-');
  const log = events.eventLog(commonDir);
  for (const shape of ['run_start', 'ticket_start', 'run_end']) SHAPES[shape](log);
  stateDatabase
    .open(commonDir)
    .prepare('UPDATE events SET id = ? WHERE id = 1')
    .run(-(2n ** 60n));
  assert.deepEqual(
    eventRead.readEvents(commonDir).map((event) => event.type),
    ['run_start', 'ticket_start', 'run_end'],
  );
});

test('a row whose column is null where its JSON holds a value is refused by name', (t) => {
  const { commonDir, row } = written(t, 'ticket_end');
  const id = plant(commonDir, { ...row, run: null });
  assertRefused(commonDir, id, 'ticket_end', /its run column is null but its JSON holds "r1"/);
});

test('hasTicketEnd finds only the ticket_end of the named Execution', (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-event-read-');
  const log = events.eventLog(commonDir, { run: 'r1' });
  log('ticket_start', { execution: '7.aaa', ticket: 7 });
  log('run_end');
  assert.equal(eventRead.hasTicketEnd(commonDir, '7.aaa'), false, 'a run_end is no ticket_end');
  log('ticket_end', { execution: '7.bbb', ticket: 7, outcome: 'needs-human' });
  assert.equal(eventRead.hasTicketEnd(commonDir, '7.aaa'), false, "another Execution's end of the same Ticket");
  assert.equal(eventRead.hasTicketEnd(commonDir, '7.bbb'), true);
});

test('hasTicketEnd counts no ticket_end row that fails the check', (t) => {
  const { commonDir, row } = written(t, 'ticket_end');
  plant(commonDir, { ...row, json: '{' });
  assert.equal(eventRead.hasTicketEnd(commonDir, 'e1'), false, 'not JSON');
  plant(commonDir, { ...row, json: row.json.replace('"execution":"e1"', '"execution":"e2"') });
  assert.equal(eventRead.hasTicketEnd(commonDir, 'e1'), false, "another Execution's JSON under this one's column");
});

test('readEvents refuses the whole read when any row is refused', (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-event-read-');
  const log = events.eventLog(commonDir);
  SHAPES.run_start(log);
  stateDatabase
    .open(commonDir)
    .prepare(
      "INSERT INTO events (ts, type, run, execution, ticket, json) VALUES ('t', 'run_end', 'r1', null, null, '{')",
    )
    .run();
  SHAPES.run_end(log);
  assertRefused(commonDir, 2, 'run_end', /its JSON does not parse: .+/);
});

test('executionEvents reports each refused row of the Execution and returns its others', (t) => {
  const commonDir = tempDirectory.stateDatabaseDirectory(t, 'gg-event-read-');
  const log = events.eventLog(commonDir);
  SHAPES.ticket_start(log);
  stateDatabase
    .open(commonDir)
    .prepare("INSERT INTO events (ts, type, run, execution, ticket, json) VALUES ('t', 'action', 'r1', 'e1', 7, '{')")
    .run();
  SHAPES['action deterministic'](log);
  const refused: eventRead.EventCorruptError[] = [];
  const read = eventRead.executionEvents(commonDir, 'e1', (err) => refused.push(err));
  assert.deepEqual(
    read.map((event) => event.type),
    ['ticket_start', 'action'],
  );
  assert.deepEqual(
    refused.map((err) => [err.name, err.id, err.raw]),
    [['EventCorruptError', 2, '{']],
  );
  assert.throws(() => eventRead.executionEvents(commonDir, 'e1'), { name: 'EventCorruptError' }, 'none reported');
});
