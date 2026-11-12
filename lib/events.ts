// Append-only event log, schema 2: one row per Event in the events table of the State Database.
import type * as approvalAction from './approval-action.ts';
import * as checks from './checks.ts';
import type * as commandCleanup from './command-cleanup.ts';
import type * as github from './github.ts';
import type * as integrity from './integrity.ts';
import * as jsonValue from './json-value.ts';
import * as record from './record.ts';
import * as stateDatabase from './state-database.ts';
import type * as visit from './visit.ts';

// Each Event shape is declared once, as its fields in their saved key order, each required or optional: the
// validation reads the declaration at runtime, and the Event's type is derived from it, so a field added to one reaches
// both. A required field must be given, though it may be null; an optional one not given is saved as null.
type Presence = 'required' | 'optional';
type Declaration<Fields> = { readonly [Field in keyof Fields]-?: Presence };
type RequiredOf<Fields, Shape> = {
  [
    Field in keyof Fields as Field extends keyof Shape ? (Shape[Field] extends 'required' ? Field : never) : never
  ]: Fields[Field];
};
type OptionalOf<Fields, Shape> = {
  [Field in keyof Fields as Field extends keyof Shape ? (Shape[Field] extends 'optional' ? Field : never) : never]:
    Fields[Field] | null;
};
type Declared<Fields, Shape> = RequiredOf<Fields, Shape> & OptionalOf<Fields, Shape>;

// Every Event's own header, ahead of its declared fields.
interface EventHeader<Type extends string> {
  schemaVersion: 2;
  time: string;
  type: Type;
}

// shortcut: Usage is typed by key, not closed; T8 owns the full Usage shape.
export type Usage = Record<string, number | null>;

// The Signals an Action's Outcome was decided from: the Harness Result, the Claim, the Check signals and the Integrity
// Assertions. An effect that reads none gives none.
export interface ActionSignals {
  harnessResult?: { status: visit.CallSignal['status']; failureClass?: string | null };
  claim?: visit.ClaimSignal;
  checks?: visit.CheckSignal[];
  integrity?: { name: string; passed: boolean; violations: integrity.IntegrityViolation[] }[];
}

interface ActionFields {
  flow: string;
  configHash: string;
  launchProfile: string | null;
  confinement: string | null;
  ticket: number;
  run: string;
  execution: string;
  vertex: string;
  visit: number;
  procedure: string | null;
  action: string;
  recovery: number;
  attempt: number;
  durationMs: number;
  outcome: string;
  direction: string;
  signals: ActionSignals;
  rule: visit.RuleIdentity;
  check: string;
  integrityViolations: integrity.IntegrityViolation[];
  retryAfterMs: number;
  // Null unless the Action failed: a Harness's class, or a remote Action's that failed for good (#251).
  failureClass: string;
  error: string;
  // What the call's or the command's Command Cleanup found (L11).
  cleanup: commandCleanup.CallCleanup;
  decision: approvalAction.Consumption['decision'];
}
export const ACTION = {
  flow: 'required',
  configHash: 'required',
  launchProfile: 'required',
  confinement: 'required',
  ticket: 'required',
  run: 'required',
  execution: 'required',
  vertex: 'required',
  visit: 'required',
  procedure: 'required',
  action: 'required',
  recovery: 'required',
  attempt: 'required',
  durationMs: 'required',
  outcome: 'required',
  direction: 'required',
  signals: 'required',
  rule: 'required',
  check: 'optional',
  integrityViolations: 'optional',
  retryAfterMs: 'optional',
  failureClass: 'optional',
  error: 'optional',
  cleanup: 'optional',
  decision: 'optional',
} as const satisfies Declaration<ActionFields>;

interface AgentFields {
  harness: string;
  agentCliVersion: string | null;
  model: string | null;
  effort: string | null;
  personaHash: string;
  tools: jsonValue.JsonValue;
  sessionInit: jsonValue.JsonValue;
  sessionId: string | null;
  sessionLineage: string | null;
  transcriptPath: string | null;
  usage: { cumulative: Usage; delta: Usage };
  exitCode: number | null;
  exitSignal: string | null;
  finalEventSubtype: string | null;
  permissionDenials: jsonValue.JsonValue;
  commandsRun: jsonValue.JsonValue;
}
export const AGENT = {
  harness: 'required',
  agentCliVersion: 'required',
  model: 'required',
  effort: 'required',
  personaHash: 'required',
  tools: 'required',
  sessionInit: 'required',
  sessionId: 'required',
  sessionLineage: 'required',
  transcriptPath: 'required',
  usage: 'required',
  exitCode: 'required',
  exitSignal: 'required',
  finalEventSubtype: 'required',
  permissionDenials: 'required',
  commandsRun: 'required',
} as const satisfies Declaration<AgentFields>;

// An agent Action's event adds the agent fields after `agent: true`; a deterministic Action's has none of them.
type ActionDeclared = Declared<ActionFields, typeof ACTION>;
export type DeterministicActionEvent = EventHeader<'action'> & ActionDeclared & { agent: false };
export type AgentActionEvent = EventHeader<'action'> &
  ActionDeclared & { agent: true } & Declared<AgentFields, typeof AGENT>;
export type ActionEvent = DeterministicActionEvent | AgentActionEvent;

// Per-file line totals, split into test and non-test files by the pinned testPaths.
export interface DiffStats {
  files: number;
  insertions: number;
  deletions: number;
  testFiles: number;
  testInsertions: number;
}

// A Bound a route passed because it was spent: a bounded Edge by its traversal key, or a Vertex by its id.
export type SpentBound = { edge: string } | { vertex: string };

interface LifecycleFields {
  run_start: { run: string };
  run_end: { run: string; tickets: { ticket: number; outcome: string }[]; failureClass: string };
  ticket_start: { run: string; execution: string; ticket: number };
  ticket_end: {
    run: string;
    execution: string;
    ticket: number;
    outcome: string;
    diffStats: DiffStats;
    terminalReason: record.TerminalReason;
    error: string;
    interrupted: record.TerminalStop['interrupted'];
  };
  label_failed: { ticket: number; change: github.LabelChange; error: string; run: string };
  visit_end: {
    run: string;
    execution: string;
    ticket: number;
    vertex: string;
    visit: number;
    outcome: string;
    rule: visit.RuleIdentity;
    next: string;
    edge: string | null;
    count: number | null;
    spent: SpentBound[];
  };
}
export const LIFECYCLE = {
  run_start: { run: 'required' },
  run_end: { run: 'required', tickets: 'optional', failureClass: 'optional' },
  ticket_start: { run: 'required', execution: 'required', ticket: 'required' },
  ticket_end: {
    run: 'required',
    execution: 'required',
    ticket: 'required',
    outcome: 'optional',
    diffStats: 'optional',
    terminalReason: 'optional',
    error: 'optional',
    interrupted: 'optional',
  },
  label_failed: { ticket: 'required', change: 'required', error: 'required', run: 'optional' },
  visit_end: {
    run: 'required',
    execution: 'required',
    ticket: 'required',
    vertex: 'required',
    visit: 'required',
    outcome: 'required',
    rule: 'required',
    next: 'required',
    edge: 'required',
    count: 'required',
    spent: 'required',
  },
} as const satisfies { [Type in keyof LifecycleFields]: Declaration<LifecycleFields[Type]> };

export type LifecycleType = keyof LifecycleFields;
type LifecycleOf<Type extends LifecycleType> = EventHeader<Type> &
  Declared<LifecycleFields[Type], (typeof LIFECYCLE)[Type]>;
export type RunStartEvent = LifecycleOf<'run_start'>;
export type RunEndEvent = LifecycleOf<'run_end'>;
export type TicketStartEvent = LifecycleOf<'ticket_start'>;
export type TicketEndEvent = LifecycleOf<'ticket_end'>;
export type LabelFailedEvent = LifecycleOf<'label_failed'>;
export type VisitEndEvent = LifecycleOf<'visit_end'>;
export type LifecycleEvent =
  RunStartEvent | RunEndEvent | TicketStartEvent | TicketEndEvent | LabelFailedEvent | VisitEndEvent;
export type Event = ActionEvent | LifecycleEvent;

type Fields = Record<string, unknown>;
// What a caller gives for an Event of a type: any of its declared fields, each of its declared type or null, so tsc
// refuses a value JSON cannot hold where the Event is made. Which fields are required is checked when it is built:
// `base` may give them. Every field is optional, which a record of unknown values would also fit, so eventLog takes
// what it is given through the save's typed gate as well.
type Given<Declared> = { [Field in keyof Declared]?: Declared[Field] | null };
// What eventLog takes of an Event's fields, as `base` or as `data`: the save's typed gate, and each key no Event of
// the kind declares as never, since a generic parameter gets no excess-key check of its own.
type DeclaredKeys<Declared> = Declared extends unknown ? keyof Declared : never;
type Gated<Given, Declared> = Given &
  NoInfer<jsonValue.JsonChecked<Given> & { [Key in Exclude<keyof Given, DeclaredKeys<Declared>>]: never }>;
export type EventType = 'action' | LifecycleType;
export type EventInput<Type extends EventType> = Type extends LifecycleType
  ? Given<LifecycleFields[Type]> & { type?: Type }
  : Given<ActionFields & AgentFields> & { type?: 'action'; agent?: boolean };
// An Event as actionEvent and lifecycleEvent build it, before eventLog adds the header's version and time. It
// distributes over a union, so each member keeps its own fields.
type EventBody<Built> = Built extends unknown ? Omit<Built, 'schemaVersion' | 'time'> : never;
type DeclaredShape = Readonly<Record<string, Presence>>;
// A Lifecycle Event's body, written as a lookup into one map of the types, so that for the union of types it is the
// union of bodies. eventLog can then build an Event that tsc checks, with no assertion (TypeScript 4.6;
// docs/research/declared-event-shapes.md).
type LifecycleBody<Type extends LifecycleType> = {
  [Each in Type]: { type: Each } & Declared<LifecycleFields[Each], (typeof LIFECYCLE)[Each]>;
}[Type];
export const declaredAs = (shape: DeclaredShape, presence: Presence): string[] =>
  Object.keys(shape).filter((field) => shape[field] === presence);
const ACTION_REQUIRED = declaredAs(ACTION, 'required');
const ACTION_OPTIONAL = declaredAs(ACTION, 'optional');
const AGENT_REQUIRED = declaredAs(AGENT, 'required');

// `database` (record.createStateDatabase) sees each Event before it is inserted; the real one, the record module, lets
// every Event through.
export function eventLog<Base extends EventInput<EventType>>(
  commonDir: string,
  base?: Gated<Base, EventInput<EventType>>,
  database: Pick<record.StateDatabase, 'beforeAppend'> = record,
): <Type extends EventType, Given extends EventInput<Type>>(type: Type, data?: Gated<Given, EventInput<Type>>) => void {
  const always: EventInput<EventType> | undefined = base;
  return (type, data) => {
    const given: EventInput<typeof type> | undefined = data;
    // `data` may be the output of actionEvent or lifecycleEvent, which already carries a matching `type`.
    const { type: own = type, ...fields }: Fields = { ...always, ...given };
    if (own !== type) throw new Error(`${type} event: field type is ${own}`);
    const event: Event = {
      schemaVersion: 2,
      time: new Date().toISOString(),
      ...(type === 'action' ? actionEvent(fields) : lifecycleEvent(type, fields)),
    };
    database.beforeAppend(event);
    // Not every Event carries the indexed columns' fields.
    const columns = event as Partial<Record<'run' | 'execution' | 'ticket', string | number | null>>;
    stateDatabase
      .open(commonDir)
      .prepare('INSERT INTO events (ts, type, run, execution, ticket, json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        event.time,
        event.type,
        columns.run ?? null,
        columns.execution ?? null,
        columns.ticket ?? null,
        jsonValue.text(event, `the ${event.type} Event`),
      );
  };
}

export function readEvents(commonDir: string): Event[] {
  return stateDatabase
    .open(commonDir)
    .prepare('SELECT json FROM events ORDER BY id')
    .all()
    .map((row) => JSON.parse(row.json as string) as Event);
}

// One Execution's Events, in the order they were appended.
export const executionEvents = (commonDir: string, execution: string): Event[] =>
  stateDatabase
    .open(commonDir)
    .prepare('SELECT json FROM events WHERE execution = ? ORDER BY id')
    .all(execution)
    .map((row) => JSON.parse(row.json as string) as Event);

// An Execution's Terminal has landed once its ticket_end is in the log.
export const hasTicketEnd = (commonDir: string, execution: string): boolean =>
  !!stateDatabase
    .open(commonDir)
    .prepare("SELECT 1 FROM events WHERE execution = ? AND type = 'ticket_end' LIMIT 1")
    .get(execution);

function closed(what: string, fields: Fields, required: string[], optional: string[] = []): void {
  // An undefined value would vanish in JSON, so it counts as missing; null is a declared absence and stays.
  for (const key of required)
    if (!Object.hasOwn(fields, key) || fields[key] === undefined)
      throw new Error(`${what}: missing required field ${key}`);
  const known = new Set([...required, ...optional]);
  for (const key of Object.keys(fields)) if (!known.has(key)) throw new Error(`${what}: unknown field ${key}`);
}

// The two halves of an Event's body, each in its declared order, an optional field null when not given. These are
// the only assertions on the way to a saved Event: tsc gives a loop over names no type, and `closed` has checked the
// names. What the builders make of the halves, tsc checks.
const requiredOf = <Of, Shape extends DeclaredShape>(shape: Shape, fields: Fields): RequiredOf<Of, Shape> =>
  Object.fromEntries(declaredAs(shape, 'required').map((key) => [key, fields[key]])) as RequiredOf<Of, Shape>;
const optionalOf = <Of, Shape extends DeclaredShape>(shape: Shape, fields: Fields): OptionalOf<Of, Shape> =>
  Object.fromEntries(declaredAs(shape, 'optional').map((key) => [key, fields[key] ?? null])) as OptionalOf<Of, Shape>;

// An agent Action's event adds the agent fields; a deterministic Action's has none of them, and `agent: false`.
export function actionEvent(fields: EventInput<'action'>): EventBody<ActionEvent> {
  const agent = fields.agent === true;
  closed('action event', fields, agent ? [...ACTION_REQUIRED, ...AGENT_REQUIRED] : ACTION_REQUIRED, [
    'agent',
    ...ACTION_OPTIONAL,
  ]);
  if (agent) for (const member of ['cumulative', 'delta']) checkUsage(fields.usage, member);
  const common = { type: 'action' as const, ...requiredOf<ActionFields, typeof ACTION>(ACTION, fields) };
  const optional = optionalOf<ActionFields, typeof ACTION>(ACTION, fields);
  return agent
    ? { ...common, agent: true, ...requiredOf<AgentFields, typeof AGENT>(AGENT, fields), ...optional }
    : { ...common, agent: false, ...optional };
}

// shortcut: checks only the Usage keys this ticket names, without closing the shape; T8 owns the full Usage shape.
const USAGE_KEYS = ['peakContextTokens', 'turns', 'toolCalls', 'compactions', 'costUsd'];
function checkUsage(usage: unknown, member: string): void {
  const memberUsage = (usage as Record<string, unknown> | null | undefined)?.[member];
  if (memberUsage === null || typeof memberUsage !== 'object')
    throw new Error(`action event: usage.${member} must be a Usage object`);
  for (const key of USAGE_KEYS) {
    const value = (memberUsage as Fields)[key];
    if (!(value === null || typeof value === 'number'))
      throw new Error(`action event: usage.${member}.${key} must be a number or null`);
  }
}

export function lifecycleEvent<Type extends LifecycleType>(type: Type, given?: EventInput<Type>): LifecycleBody<Type> {
  const fields: Fields = given ?? {};
  // An own key only: `toString` or `__proto__` would otherwise find Object.prototype's member and pass as a type.
  if (!Object.hasOwn(LIFECYCLE, type)) throw new Error(`unknown lifecycle event type ${type}`);
  const shape: DeclaredShape = LIFECYCLE[type];
  const required = declaredAs(shape, 'required');
  const optional = declaredAs(shape, 'optional');
  closed(`${type} event`, fields, required, optional);
  return {
    type,
    ...requiredOf<LifecycleFields[Type], (typeof LIFECYCLE)[Type]>(LIFECYCLE[type], fields),
    ...optionalOf<LifecycleFields[Type], (typeof LIFECYCLE)[Type]>(LIFECYCLE[type], fields),
  };
}

// Per-file line counts (git.diffStats; a binary file's are null) -> totals, split into test and non-test files by the
// pinned testPaths.
export function diffStats(
  files: { path: string; insertions: number | null; deletions: number | null }[],
  testPaths: string[],
): DiffStats {
  const isTest = checks.testPathMatcher(testPaths);
  const stats = { files: 0, insertions: 0, deletions: 0, testFiles: 0, testInsertions: 0 };
  for (const { path, insertions, deletions } of files) {
    const added = insertions ?? 0;
    stats.files++;
    stats.insertions += added;
    stats.deletions += deletions ?? 0;
    if (isTest(path)) {
      stats.testFiles++;
      stats.testInsertions += added;
    }
  }
  return stats;
}
