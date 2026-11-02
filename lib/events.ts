// Append-only event log, schema 2: one row per Event in the events table of the State Database.
import * as checks from './checks.mjs';
import * as record from './record.ts';
import * as sqlite from './sqlite.ts';
import type * as visit from './visit.ts';

// Each Event shape is declared once, as its fields in their saved key order, each required or optional: the
// validation reads the declaration at runtime, and the Event's type is derived from it, so a field added to one reaches
// both. A required field must be given, though it may be null; an optional one not given is saved as null.
type Presence = 'required' | 'optional';
type Declaration<Fields> = { readonly [Field in keyof Fields]-?: Presence };
type Declared<Fields, Shape> = {
  [
    Field in keyof Fields as Field extends keyof Shape ? (Shape[Field] extends 'required' ? Field : never) : never
  ]: Fields[Field];
} & {
  [Field in keyof Fields as Field extends keyof Shape ? (Shape[Field] extends 'optional' ? Field : never) : never]:
    Fields[Field] | null;
};

// Every Event's own header, ahead of its declared fields.
interface EventHeader<Type extends string> {
  schemaVersion: 2;
  time: string;
  type: Type;
}

// shortcut: Usage is typed by key, not closed; T8 owns the full Usage shape.
type Usage = Record<string, number | null>;

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
  signals: Record<string, unknown>;
  rule: visit.RuleIdentity;
  check: string;
  integrityViolations: unknown[];
  retryAfterMs: number;
  error: string;
}
const ACTION = {
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
  error: 'optional',
} as const satisfies Declaration<ActionFields>;

interface AgentFields {
  harness: string;
  agentCliVersion: string | null;
  model: string;
  effort: string;
  personaHash: string;
  tools: unknown;
  sessionInit: unknown;
  sessionId: string | null;
  sessionLineage: string | null;
  transcriptPath: string | null;
  usage: { cumulative: Usage; delta: Usage };
  exitCode: number | null;
  exitSignal: string | null;
  finalEventSubtype: string | null;
  permissionDenials: unknown;
  commandsRun: unknown;
  failureClass: string | null;
}
const AGENT = {
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
  failureClass: 'required',
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
    interrupted: unknown;
  };
  label_failed: { ticket: number; change: unknown; error: string; run: string };
}
const LIFECYCLE = {
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
} as const satisfies { [Type in keyof LifecycleFields]: Declaration<LifecycleFields[Type]> };

export type LifecycleType = keyof LifecycleFields;
type LifecycleOf<Type extends LifecycleType> = EventHeader<Type> &
  Declared<LifecycleFields[Type], (typeof LIFECYCLE)[Type]>;
export type RunStartEvent = LifecycleOf<'run_start'>;
export type RunEndEvent = LifecycleOf<'run_end'>;
export type TicketStartEvent = LifecycleOf<'ticket_start'>;
export type TicketEndEvent = LifecycleOf<'ticket_end'>;
export type LabelFailedEvent = LifecycleOf<'label_failed'>;
export type LifecycleEvent = RunStartEvent | RunEndEvent | TicketStartEvent | TicketEndEvent | LabelFailedEvent;
export type Event = ActionEvent | LifecycleEvent;

type Fields = Record<string, unknown>;
type DeclaredShape = Readonly<Record<string, Presence>>;
const declaredAs = (shape: DeclaredShape, presence: Presence): string[] =>
  Object.keys(shape).filter((field) => shape[field] === presence);
const ACTION_REQUIRED = declaredAs(ACTION, 'required');
const ACTION_OPTIONAL = declaredAs(ACTION, 'optional');
const AGENT_REQUIRED = declaredAs(AGENT, 'required');

// `database` (record.stateDatabase) sees each Event before it is inserted; the real one, the record module, lets every
// Event through.
export function eventLog(
  commonDir: string,
  base: Fields = {},
  database: Pick<record.StateDatabase, 'beforeAppend'> = record,
): (type: 'action' | LifecycleType, data?: Fields) => void {
  return (type, data = {}) => {
    // `data` may be the output of actionEvent or lifecycleEvent, which already carries a matching `type`.
    const { type: own = type, ...fields } = { ...base, ...data };
    if (own !== type) throw new Error(`${type} event: field type is ${own}`);
    const event = {
      schemaVersion: 2,
      time: new Date().toISOString(),
      ...(type === 'action' ? actionEvent(fields) : lifecycleEvent(type, fields)),
    } as Event;
    database.beforeAppend(event);
    // Not every Event carries the indexed columns' fields.
    const columns = event as Partial<Record<'run' | 'execution' | 'ticket', string | number | null>>;
    sqlite
      .openDb(commonDir)
      .prepare('INSERT INTO events (ts, type, run, execution, ticket, json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        event.time,
        event.type,
        columns.run ?? null,
        columns.execution ?? null,
        columns.ticket ?? null,
        JSON.stringify(event),
      );
  };
}

export function readEvents(commonDir: string): Event[] {
  return sqlite
    .openDb(commonDir)
    .prepare('SELECT json FROM events ORDER BY id')
    .all()
    .map((row) => JSON.parse(row.json as string) as Event);
}

// An Execution's Terminal has landed once its ticket_end is in the log.
export const hasTicketEnd = (commonDir: string, execution: string): boolean =>
  !!sqlite
    .openDb(commonDir)
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

// An Event names its fields in one declared order, an optional one null when not given.
const ordered = (fields: Fields, required: string[], optional: string[]): Fields =>
  Object.fromEntries([
    ...required.map((key) => [key, fields[key]]),
    ...optional.map((key) => [key, fields[key] ?? null]),
  ]);

// An agent Action's event adds the agent fields; a deterministic Action's has none of them, and `agent: false`.
export function actionEvent(fields: Fields): Omit<ActionEvent, 'schemaVersion' | 'time'> {
  const agent = fields.agent === true;
  closed('action event', fields, agent ? [...ACTION_REQUIRED, ...AGENT_REQUIRED] : ACTION_REQUIRED, [
    'agent',
    ...ACTION_OPTIONAL,
  ]);
  if (agent) for (const member of ['cumulative', 'delta']) checkUsage(fields.usage, member);
  return {
    type: 'action',
    ...ordered(fields, ACTION_REQUIRED, []),
    agent,
    ...ordered(fields, agent ? AGENT_REQUIRED : [], ACTION_OPTIONAL),
  } as Omit<ActionEvent, 'schemaVersion' | 'time'>;
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

export function lifecycleEvent<Type extends LifecycleType>(
  type: Type,
  fields: Fields = {},
): Omit<LifecycleOf<Type>, 'schemaVersion' | 'time'> {
  const shape: DeclaredShape | undefined = LIFECYCLE[type];
  if (!shape) throw new Error(`unknown lifecycle event type ${type}`);
  const required = declaredAs(shape, 'required');
  const optional = declaredAs(shape, 'optional');
  closed(`${type} event`, fields, required, optional);
  return { type, ...ordered(fields, required, optional) } as Omit<LifecycleOf<Type>, 'schemaVersion' | 'time'>;
}

// Per-file line counts (git.diffStats; a binary file's are null) -> totals, split into test and non-test files by the
// pinned testPaths.
export function diffStats(
  files: { path: string; insertions: number | null; deletions: number | null }[],
  testPaths: unknown,
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
