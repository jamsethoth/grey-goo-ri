// Append-only event log, schema 2: one row per Event in the events table of the State Database. lib/event-read.ts
// reads it back, checked against the declarations here.
import type * as approvalAction from './approval-action.ts';
import * as checks from './checks.ts';
import * as eventDeclaration from './event-declaration.ts';
import type * as commandCleanup from './command-cleanup.ts';
import type * as github from './github.ts';
import type * as integrity from './integrity.ts';
import type * as jsonValue from './json-value.ts';
import type * as record from './record.ts';
import * as stateDatabase from './state-database/index.ts';
import type * as visit from './visit.ts';

type Declaration<Fields> = eventDeclaration.Declaration<Fields>;
type Declared<Fields, Shape> = eventDeclaration.Declared<Fields, Shape>;

// The frozen Event schema version (docs/interfaces/events.md); a change to it needs a new ADR (#23).
export const EVENT_SCHEMA_VERSION = 2;
// Every Event's own header, ahead of its declared fields.
interface EventHeader<Type extends string> {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  time: string;
  type: Type;
}

// An agent's token and cost counts, closed at the freeze (#23, Clarify Q2 B): each USAGE_FIELDS key, null where the
// Harness does not report it, and where a cost figure came from.
export interface Usage {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  costUsd: number | null;
  peakContextTokens: number | null;
  turns: number | null;
  toolCalls: number | null;
  compactions: number | null;
  costBasis?: 'reported' | 'priced' | null;
}

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
  owner: record.Owner;
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
  owner: 'required',
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
  ticket_start: { run: string; execution: string; ticket: number; owner: record.Owner };
  ticket_end: {
    run: string;
    execution: string;
    ticket: number;
    owner: record.Owner;
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
    owner: record.Owner;
    vertex: string;
    visit: number;
    outcome: string;
    rule: visit.RuleIdentity;
    next: string;
    edge: string | null;
    count: number | null;
    spent: SpentBound[];
  };
  config_change: {
    run: string;
    execution: string;
    ticket: number;
    owner: record.Owner;
    vertex: string;
    visit: number;
  } & ConfigChange;
  // A person's gg work verb (L12), `human` their login: done resolved the Ticket; resume re-entered it at `vertex`
  // from the branch tip `head`, its open intents in `superseded` marked finished with nothing found.
  ticket_resolved: HumanVerb;
  ticket_resumed: HumanVerb & { vertex: string; head: string; superseded: string[] };
}
type HumanVerb = { run: string; execution: string; ticket: number; owner: record.Owner; human: string };
// A resumed Execution's Config Hash, from the one it last ran under to the Run's, at the Vertex entry that moved it.
interface ConfigChange {
  from: string;
  to: string;
}
const TICKET_KEYS = { execution: 'required', ticket: 'required', owner: 'required' } as const;
const HUMAN_VERB = { run: 'optional', ...TICKET_KEYS, human: 'required' } as const;
export const LIFECYCLE = {
  run_start: { run: 'required' },
  run_end: { run: 'required', tickets: 'optional', failureClass: 'optional' },
  ticket_start: { run: 'required', execution: 'required', ticket: 'required', owner: 'required' },
  ticket_end: {
    run: 'required',
    execution: 'required',
    ticket: 'required',
    owner: 'required',
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
    owner: 'required',
    vertex: 'required',
    visit: 'required',
    outcome: 'required',
    rule: 'required',
    next: 'required',
    edge: 'required',
    count: 'required',
    spent: 'required',
  },
  config_change: {
    run: 'required',
    execution: 'required',
    ticket: 'required',
    owner: 'required',
    vertex: 'required',
    visit: 'required',
    from: 'required',
    to: 'required',
  },
  ticket_resolved: HUMAN_VERB,
  ticket_resumed: { ...HUMAN_VERB, vertex: 'required', head: 'required', superseded: 'required' },
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
export type ConfigChangeEvent = LifecycleOf<'config_change'>;
export type TicketResolvedEvent = LifecycleOf<'ticket_resolved'>;
export type TicketResumedEvent = LifecycleOf<'ticket_resumed'>;
export type LifecycleEvent =
  | RunStartEvent
  | RunEndEvent
  | TicketStartEvent
  | TicketEndEvent
  | LabelFailedEvent
  | VisitEndEvent
  | ConfigChangeEvent
  | TicketResolvedEvent
  | TicketResumedEvent;
export type Event = ActionEvent | LifecycleEvent;

type Fields = eventDeclaration.Fields;
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
// A Lifecycle Event's body, written as a lookup into one map of the types, so that for the union of types it is the
// union of bodies. eventLog can then build an Event that tsc checks, with no assertion (TypeScript 4.6;
// docs/research/declared-event-shapes.md).
type LifecycleBody<Type extends LifecycleType> = {
  [Each in Type]: { type: Each } & Declared<LifecycleFields[Each], (typeof LIFECYCLE)[Each]>;
}[Type];
const { declaredAs, closed, requiredOf, optionalOf } = eventDeclaration;
const ACTION_REQUIRED = declaredAs(ACTION, 'required');
const ACTION_OPTIONAL = declaredAs(ACTION, 'optional');
const AGENT_REQUIRED = declaredAs(AGENT, 'required');

// The Event goes in through `database`; the real one, lib/state-database/, inserts every Event.
export function eventLog<Base extends EventInput<EventType>>(
  commonDir: string,
  base?: Gated<Base, EventInput<EventType>>,
  database: Pick<stateDatabase.StateDatabase, 'appendEvent'> = stateDatabase,
): <Type extends EventType, Given extends EventInput<Type>>(type: Type, data?: Gated<Given, EventInput<Type>>) => void {
  const always: EventInput<EventType> | undefined = base;
  return (type, data) => {
    const given: EventInput<typeof type> | undefined = data;
    // `data` may be the output of actionEvent or lifecycleEvent, which already carries a matching `type`.
    const { type: own = type, ...fields }: Fields = { ...always, ...given };
    if (own !== type) throw new Error(`${type} event: field type is ${own}`);
    const event: Event = {
      schemaVersion: EVENT_SCHEMA_VERSION,
      time: new Date().toISOString(),
      ...(type === 'action' ? actionEvent(fields) : lifecycleEvent(type, fields)),
    };
    database.appendEvent(commonDir, event);
  };
}

// An agent Action's event adds the agent fields; a deterministic Action's has none of them, and `agent: false`.
export function actionEvent(fields: EventInput<'action'>): EventBody<ActionEvent> {
  const agent = fields.agent === true;
  closed('action event', fields, agent ? [...ACTION_REQUIRED, ...AGENT_REQUIRED] : ACTION_REQUIRED, [
    'agent',
    ...ACTION_OPTIONAL,
  ]);
  if (agent) for (const member of ['cumulative', 'delta']) eventDeclaration.checkUsage(fields.usage, member);
  const common = { type: 'action' as const, ...requiredOf<ActionFields, typeof ACTION>(ACTION, fields) };
  const optional = optionalOf<ActionFields, typeof ACTION>(ACTION, fields);
  return agent
    ? { ...common, agent: true, ...requiredOf<AgentFields, typeof AGENT>(AGENT, fields), ...optional }
    : { ...common, agent: false, ...optional };
}

export function lifecycleEvent<Type extends LifecycleType>(type: Type, given?: EventInput<Type>): LifecycleBody<Type> {
  const fields: Fields = given ?? {};
  // An own key only: `toString` or `__proto__` would otherwise find Object.prototype's member and pass as a type.
  if (!Object.hasOwn(LIFECYCLE, type)) throw new Error(`unknown lifecycle event type ${type}`);
  const shape: eventDeclaration.DeclaredShape = LIFECYCLE[type];
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
