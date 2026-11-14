import { randomBytes } from 'node:crypto';
import type * as approval from './approval.ts';
import type * as sideEffect from './effects/side-effect.ts';
import type * as events from './events.ts';
import * as jsonValue from './json-value.ts';
import type * as marker from './marker.ts';
import * as stateDatabase from './state-database.ts';
import type * as visit from './visit.ts';
import * as writeAhead from './write-ahead.ts';
import * as recordJson from './record-json.ts';

export { RecordCorruptError, fromJson, toJson } from './record-json.ts';
export type { ExecutionRecordJson, VisitStateJson } from './record-json.ts';

// A record transition whose Event failed was rolled back, but the record object still holds it: saving that object
// again would publish the transition without its Event, so it is rethrown and nothing more of it is saved.
export class RecordSaveError extends Error {
  constructor(cause: unknown) {
    super(`the record and its Event were not saved: ${(cause as Error | null | undefined)?.message ?? cause}`, {
      cause,
    });
    this.name = 'RecordSaveError';
  }
}

// Who decided an Execution's end state: a hold by its name, a human by the label they set, or an Action by its
// identity, which has no Visit or Action when the stop came before one. Exactly one of the three: each form rules out
// the others' keys, so a mix or an empty object does not compile, and any key is still read without a test first
// (docs/research/exclusive-variant-shapes.md). A hold or a human that cut a Visit off names it with an Action's keys,
// all four or none (#341). A reader tells the forms apart with `!== undefined` or a literal, not with `in`, and a
// fourth form adds its keys to the other three.
type ActionKeys = { vertex: string; visit: number | null; action: string | null; recovery: number };
type NoActionKeys = { vertex?: never; visit?: never; action?: never; recovery?: never };
type Hold = { hold: string | null; human?: never };
type Human = { human: string; hold?: never };
export type DecidedByHold = Hold & NoActionKeys;
export type DecidedByHoldInVisit = Hold & ActionKeys;
export type DecidedByHuman = Human & NoActionKeys;
export type DecidedByHumanInVisit = Human & ActionKeys;
export type DecidedByAction = { hold?: never; human?: never } & ActionKeys;
export type DecidedBy = DecidedByHold | DecidedByHoldInVisit | DecidedByHuman | DecidedByHumanInVisit | DecidedByAction;

// Why an Execution reached its end state: the Action, hold or human that decided it (request 3.1).
export interface TerminalReason {
  decidedBy: DecidedBy;
  outcome: string | null;
  rule: visit.RuleIdentity | null;
  text: string;
}

// How the Terminal classifies the stop, every field present (terminal.declaredStop).
export interface TerminalStop {
  outcome: string;
  response: jsonValue.JsonValue;
  // The stopped Action's identity, or null for a stop decided before any Action.
  actionRef: marker.ActionIdentity | null;
  held: boolean;
  abandoned: boolean;
  inProgress: boolean;
  fresh: boolean;
  // A stop token's `stopped` table decided, and `commentTemplate` names the template its comment renders.
  stopped: boolean;
  commentTemplate: string | null;
  advice: string | null;
  detail: string | null;
  error: string | null;
  failureClass: string | null;
  interrupted: { terminal: string; terminalReason: TerminalReason } | null;
}

// A hold, abandonment or fault admission decided, every field present (run.declaredAdmissionStop).
export interface AdmissionStop {
  kind: 'hold' | 'abandon' | 'fault';
  name: string | null;
  terminalReasonText: string | null;
  fresh: boolean;
  advice: string | null;
  detail: string | null;
  inProgress: boolean;
  error: string | null;
}

// Where the Execution is: an Action's identity and Attempt, or a Terminal's Vertex with no Visit or Action.
export interface Cursor {
  vertex: string;
  visit: number | null;
  action: string | null;
  recovery: number;
  attempt: number;
}

// An agent Session gg can resume, by Vertex, Visit and Action.
export interface SessionEntry {
  sessionId: string | null;
  harness: string;
  personaHash: string;
  transcriptPath: string | null;
  cumulativeUsage: events.Usage;
  vertex: string;
  model: string | null;
  effort: string | null;
  personaName: string;
}

export interface ExecutionRecord {
  schemaVersion: number;
  commonDir: string;
  repository: string;
  execution: string;
  ticket: number;
  epic: number | null;
  flow: string;
  configHash: string;
  run: string;
  state: string;
  terminalReason: TerminalReason | null;
  terminalStop: TerminalStop | null;
  admissionStop: AdmissionStop | null;
  cursor: Cursor;
  // Visits by Vertex and traversals by bounded Edge (from->to:outcome): Maps, so a Vertex such as __proto__ counts like
  // any other (#174). The saved JSON holds them as objects.
  visits: Map<string, number>;
  traversals: Map<string, number>;
  retries: Record<
    string,
    Partial<Record<NonNullable<visit.TableResolution['retryKind']>, number>> & { remote?: sideEffect.RemoteRetry }
  >;
  sessions: Record<string, SessionEntry>;
  attempts: number;
  outputs: visit.ActionOutput[];
  testCommits: { first: string | null; baseline: string | null };
  history: visit.HistoryItem[];
  worktree: string;
  branch: string;
  base: string;
  pr: number | null;
  approvalRequest: approval.PendingInstance | null;
  configurationSnapshot: visit.ConfigurationSnapshot | null;
  visitState: visit.VisitState | null;
  activity: { busy: boolean; generation: number };
  heartbeat: string | null;
  writeAheadLog: writeAhead.WriteAheadEntry[];
}

export interface EpicRecord {
  schemaVersion: number;
  commonDir: string;
  epic: number;
  planDecision: jsonValue.JsonValue;
  approvalRequest: approval.PendingInstance | null;
}

type RecordKind = 'ticket' | 'epic';

// The cursor of a Terminal: an end state or needs-human, with no Visit or Action left to run.
export const terminalCursor = (vertex: string) => ({ vertex, visit: null, action: null, recovery: 0, attempt: 1 });

export interface ExecutionStart {
  commonDir: string;
  repository: string;
  ticket: number;
  epic?: number | null;
  flow: { name: string; entry: string };
  configHash: string;
  run: string;
  worktree: string;
  branch: string;
  base: string;
}

// Every field the Execution Record will ever hold is declared here, null until set; save refuses any other key.
export function createExecutionRecord(start: ExecutionStart): ExecutionRecord {
  const { commonDir, ticket, epic = null, flow, configHash, run, worktree, branch, base } = start;
  return {
    schemaVersion: recordJson.SCHEMA_VERSION,
    commonDir,
    repository: start.repository,
    execution: `${ticket}.${randomBytes(3).toString('hex')}`,
    ticket,
    epic,
    flow: flow.name,
    configHash,
    run,
    state: 'active',
    // Why the Execution reached its end state, kept beside the state (request 3.1).
    terminalReason: null,
    // How the Terminal classifies the stop: held, fault, abandoned, a run stop or a stop token (terminal.ts).
    terminalStop: null,
    // A hold, abandonment or fault admission decided, until its Terminal reports it (admission.ts).
    admissionStop: null,
    cursor: { vertex: flow.entry, visit: 1, action: null, recovery: 0, attempt: 1 },
    visits: new Map(),
    traversals: new Map(),
    retries: {},
    sessions: {},
    // The Flow Attempts entered, which the Action Cap bounds (request 3.3).
    attempts: 0,
    // Each Action's outputs in Visit order, `{ vertex, visit, action, value }`, which later Vertices' inputs read.
    outputs: [],
    // gg's own: the Execution's first test commit, and the commit whose tests a Green Check holds immutable.
    testCommits: { first: null, baseline: null },
    history: [],
    worktree,
    branch,
    base,
    pr: null,
    // The open Approval Request: its Pending Instance and Approval Digest.
    approvalRequest: null,
    // The Configuration Snapshot the current Visit entered with.
    configurationSnapshot: null,
    // The current Visit's progress, saved so a restart routes what it already settled (interpreter.runVisit).
    visitState: null,
    activity: { busy: false, generation: 0 },
    heartbeat: null,
    // Intent, evidence and completion of every side effect (request 3.5).
    writeAheadLog: [],
  };
}

export function createEpicRecord({ commonDir, epic }: { commonDir: string; epic: number }): EpicRecord {
  return { schemaVersion: recordJson.SCHEMA_VERSION, commonDir, epic, planDecision: null, approvalRequest: null };
}

const declaredFields = (kind: RecordKind): string[] =>
  Object.keys(
    kind === 'ticket'
      ? createExecutionRecord({ flow: {}, ticket: 0 } as ExecutionStart)
      : createEpicRecord({ commonDir: null, epic: 0 } as unknown as { commonDir: string; epic: number }),
  );
const DECLARED = { ticket: declaredFields('ticket'), epic: declaredFields('epic') };

// A field no create function declares, or one a module deleted, would change the record's shape after the freeze (#23).
function assertDeclared(kind: RecordKind, record: ExecutionRecord | EpicRecord): void {
  const declared = DECLARED[kind];
  const undeclared = Object.keys(record).filter((key) => !declared.includes(key));
  const missing = declared.filter((key) => !Object.hasOwn(record, key));
  if (undeclared.length) throw new Error(`the ${kind} record has undeclared fields ${undeclared.join(', ')}`);
  if (missing.length) throw new Error(`the ${kind} record is missing declared fields ${missing.join(', ')}`);
}

type AnyRecord = ExecutionRecord | EpicRecord;
// Inserts the Event that commits with a record's row; see saveRecord.
type WriteEvent = (() => void) | null;

// With `writeEvent`, the row and the Event it inserts on the same connection commit together or not at all. It must be
// synchronous: nothing awaited may run inside the transaction. Any failed save is a RecordSaveError, after which the
// caller saves nothing more of the record.
function saveRecord(record: AnyRecord, writeEvent: WriteEvent, beforeSave: (record: AnyRecord) => void): void {
  const kind: RecordKind = 'execution' in record ? 'ticket' : 'epic';
  const connection = stateDatabase.open(record.commonDir);
  const upsert = () => {
    assertDeclared(kind, record);
    beforeSave(record);
    const row =
      'execution' in record
        ? jsonValue.text(recordJson.toJson(record), "the Execution Record's row", 2)
        : jsonValue.text(recordJson.epicJson(record), "the Epic Record's row", 2);
    connection
      .prepare(
        'INSERT INTO records (kind, n, json) VALUES (?, ?, ?) ON CONFLICT(kind, n) DO UPDATE SET json = excluded.json',
      )
      .run(kind, kind === 'ticket' ? (record as ExecutionRecord).ticket : record.epic, `${row}\n`);
  };
  if (!writeEvent) {
    try {
      return void upsert();
    } catch (err) {
      throw new RecordSaveError(err);
    }
  }
  try {
    connection.exec('BEGIN IMMEDIATE');
    upsert();
    writeEvent();
    connection.exec('COMMIT');
  } catch (err) {
    if (connection.isTransaction) connection.exec('ROLLBACK');
    throw new RecordSaveError(err);
  }
}

// Each kind's row reads back as its own record: the row's kind is the one asked for, and parseRow reads it by kind.
export function load(commonDir: string, kind: 'ticket', recordNumber: number): ExecutionRecord | null;
export function load(commonDir: string, kind: 'epic', recordNumber: number): EpicRecord | null;
export function load(commonDir: string, kind: RecordKind, recordNumber: number): AnyRecord | null {
  const row = stateDatabase
    .open(commonDir)
    .prepare('SELECT kind, n, json FROM records WHERE kind = ? AND n = ?')
    .get(kind, recordNumber) as recordJson.RecordRow | undefined;
  return row ? recordJson.parseRow(commonDir, row) : null;
}

// A record's row deleted, as gg work abandon forgets a Ticket's position; its Events stay. Says whether one was.
export function removeRecord(commonDir: string, kind: RecordKind, recordNumber: number): boolean {
  const deleted = stateDatabase
    .open(commonDir)
    .prepare('DELETE FROM records WHERE kind = ? AND n = ?')
    .run(kind, recordNumber);
  return Number(deleted.changes) > 0;
}

// One corrupt record must not hide every other worktree's activity: it is reported, not fatal.
interface LoadAllOptions {
  onCorrupt?: (err: recordJson.RecordCorruptError) => void;
}
export function loadAll(commonDir: string, kind: 'ticket', options?: LoadAllOptions): ExecutionRecord[];
export function loadAll(commonDir: string, kind: 'epic', options?: LoadAllOptions): EpicRecord[];
export function loadAll(
  commonDir: string,
  kind: RecordKind,
  { onCorrupt = () => {} }: LoadAllOptions = {},
): AnyRecord[] {
  const rows = stateDatabase
    .open(commonDir)
    .prepare('SELECT kind, n, json FROM records WHERE kind = ? ORDER BY n')
    .all(kind) as unknown as recordJson.RecordRow[];
  return rows.flatMap((row) => {
    try {
      return [recordJson.parseRow(commonDir, row)];
    } catch (err) {
      if (!(err instanceof recordJson.RecordCorruptError)) throw err;
      onCorrupt(err);
      return [];
    }
  });
}

// The State Database's writes. `beforeSave` sees each record about to be written, and `beforeAppend` each Event about
// to be inserted (events.eventLog), and either throws to fail that write, as a disk error would. The entry point passes
// neither; a test passes them to see or fail chosen writes.
export function createStateDatabase({
  beforeSave = () => {},
  beforeAppend = () => {},
}: {
  beforeSave?: (record: AnyRecord) => void;
  beforeAppend?: (event: events.Event) => void;
} = {}) {
  const save = (record: AnyRecord, writeEvent: WriteEvent = null) => saveRecord(record, writeEvent, beforeSave);

  function append(record: ExecutionRecord, entry: writeAhead.WriteAheadEntry, writeEvent?: WriteEvent) {
    record.writeAheadLog.push(entry);
    return save(record, writeEvent);
  }

  const intent = (record: ExecutionRecord, actionMarker: string, effect: string, payload: writeAhead.Payload) =>
    append(record, writeAhead.entryOf('intent', actionMarker, effect, { payload }));

  const evidence = (record: ExecutionRecord, actionMarker: string, evidence: writeAhead.WriteAheadEntry['evidence']) =>
    append(
      record,
      writeAhead.entryOf('evidence', actionMarker, writeAhead.effectOf(record, actionMarker), { evidence }),
    );

  // `evidence`, when given, is saved in the same write as the completion, and `event` commits with both.
  function complete(
    record: ExecutionRecord,
    actionMarker: string,
    { evidence: found, event = null }: { evidence?: writeAhead.WriteAheadEntry['evidence']; event?: WriteEvent } = {},
  ) {
    const effect = writeAhead.effectOf(record, actionMarker);
    if (found !== undefined)
      record.writeAheadLog.push(writeAhead.entryOf('evidence', actionMarker, effect, { evidence: found }));
    return append(record, writeAhead.entryOf('complete', actionMarker, effect), event);
  }

  return { save, intent, evidence, complete, beforeAppend };
}

// The State Database the entry point builds and passes down as `database` (ADR 0019).
export type StateDatabase = ReturnType<typeof createStateDatabase>;

// The real State Database, for callers that take no seam: this module is itself one, so it can stand for a `database`.
export const { save, intent, evidence, complete, beforeAppend } = createStateDatabase();
