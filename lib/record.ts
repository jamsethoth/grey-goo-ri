import { randomBytes } from 'node:crypto';
import type * as approval from './approval.ts';
import type * as sideEffect from './effects/side-effect.ts';
import type * as events from './events.ts';
import * as contract from './harnesses/contract.ts';
import * as jsonValue from './json-value.ts';
import type * as marker from './marker.ts';
import type * as visit from './visit.ts';
import type * as writeAhead from './write-ahead.ts';
import * as recordJson from './record-json.ts';

export { RECORD_SCHEMA_VERSION, RecordCorruptError, fromJson, toJson } from './record-json.ts';
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

// Who decided an Execution's end state: a hold by its name, an abandonment by the State Label a human set, an Action by
// its identity, which has no Visit or Action when the stop came before one, or a person by their login (gg work done,
// #133). Exactly one of the four: each form rules out the others' keys, so a mix or an empty object does not compile,
// and any key is still read without a test first (docs/research/exclusive-variant-shapes.md). A hold or an abandonment
// that cut a Visit off names it with an Action's keys, all four or none (#341). A reader tells the forms apart with
// `!== undefined` or a literal, not with `in`, and a fifth form adds its keys to the other four.
type ActionKeys = { vertex: string; visit: number | null; action: string | null; recovery: number };
type NoActionKeys = { vertex?: never; visit?: never; action?: never; recovery?: never };
type Hold = { hold: string | null; label?: never; human?: never };
type Label = { label: string; hold?: never; human?: never };
export type DecidedByHold = Hold & NoActionKeys;
export type DecidedByHoldInVisit = Hold & ActionKeys;
export type DecidedByLabel = Label & NoActionKeys;
export type DecidedByLabelInVisit = Label & ActionKeys;
export type DecidedByAction = { hold?: never; label?: never; human?: never } & ActionKeys;
export type DecidedByHuman = { human: string; hold?: never; label?: never } & NoActionKeys;
export type DecidedBy =
  DecidedByHold | DecidedByHoldInVisit | DecidedByLabel | DecidedByLabelInVisit | DecidedByAction | DecidedByHuman;

// Why an Execution reached its end state: the Action, hold or abandonment that decided it (request 3.1).
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
  // Each Session the Action handed off past its contextBudget, oldest first, kept resumable for a question (#430).
  handedOff?: HandedOffSession[];
}

// A Session's cumulativeUsage is its last reported total, the baseline its next resumed call is given: a resumed call
// that left a count null, as a Claude call stopped before its result line does, keeps the Session's earlier value
// (#487 Q1 A).
export function sessionTotal(earlier: events.Usage | undefined, usage: events.Usage): events.Usage {
  if (!earlier) return usage;
  const counts = contract.usageOf((field) => usage[field] ?? earlier[field]);
  return 'costBasis' in usage ? { ...counts, costBasis: usage.costBasis ?? earlier.costBasis ?? null } : counts;
}

// A Session an agent handed off: its id and transcript, its total Usage, and the Attempt that ran it.
export interface HandedOffSession {
  sessionId: string | null;
  transcriptPath: string | null;
  cumulativeUsage: events.Usage;
  attempt: number;
}

// Who an Execution belongs to (X3): a Ticket today, or an Epic for request slice 7's planning Executions. The
// record's `ticket` equals `number` either way, so neither the row's key nor the Execution's id changes (#23, Q6 A).
export interface Owner {
  kind: 'ticket' | 'epic';
  number: number;
}

export interface ExecutionRecord {
  schemaVersion: number;
  commonDir: string;
  repository: string;
  execution: string;
  ticket: number;
  owner: Owner;
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
    Partial<Record<NonNullable<visit.TableResolution['retryKind']>, number>> & {
      remote?: sideEffect.RemoteRetry;
      // An Interrupted Attempt's retry, spent before the retried Attempt launches (ADR 0011).
      crash?: number;
    }
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
    schemaVersion: recordJson.RECORD_SCHEMA_VERSION,
    commonDir,
    repository: start.repository,
    execution: `${ticket}.${randomBytes(3).toString('hex')}`,
    ticket,
    // Only a Ticket owns an Execution until request slice 7 (X3).
    owner: { kind: 'ticket', number: ticket },
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
  return {
    schemaVersion: recordJson.RECORD_SCHEMA_VERSION,
    commonDir,
    epic,
    planDecision: null,
    approvalRequest: null,
  };
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

// The row a record saves as (lib/state-database/): checked against its declared fields, seen by `beforeSave`, which may
// throw to fail the write, then serialized.
export function rowOf(saved: AnyRecord, beforeSave: (record: AnyRecord) => void): recordJson.RecordRow {
  const kind: RecordKind = 'execution' in saved ? 'ticket' : 'epic';
  assertDeclared(kind, saved);
  beforeSave(saved);
  const row =
    'execution' in saved
      ? jsonValue.text(recordJson.toJson(saved), "the Execution Record's row", 2)
      : jsonValue.text(recordJson.epicJson(saved), "the Epic Record's row", 2);
  // eslint-disable-next-line id-length -- n is the records table's column
  return { kind, n: 'execution' in saved ? saved.ticket : saved.epic, json: `${row}\n` };
}

// The real State Database's record reads and writes, for callers that take no seam; a Run's path reaches them through
// the database it is handed (#367).
export { complete, evidence, intent, load, loadAll, removeRecord, save } from './state-database/index.ts';
export type { StateDatabase } from './state-database/index.ts';
