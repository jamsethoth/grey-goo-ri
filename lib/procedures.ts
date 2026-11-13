// The Action and Check kinds a Procedure may declare (#106): each kind's own keys, and what each Action kind produces
// as `<action id>.<output>` (W2). The Procedures themselves are configuration, declared in a Source; the interpreter
// runs each kind.

import type * as jsonValue from './json-value.ts';
import type * as referencePaths from './reference-paths.ts';
import type * as rules from './rules.ts';

export const ACTION_KEYS = {
  agent: ['brief', 'schema'],
  check: ['kind', 'recoverBrief', 'recoverable'],
  commit: ['type'],
  push: [],
  'pr-upsert': ['body', 'with'],
  'pr-ready': [],
  comment: ['target', 'body'],
  'await-approval': ['decisions'],
};
export type ActionKind = keyof typeof ACTION_KEYS;
// The keys whose value names a file of the Flow's Source, by where they sit: on any Action, in a Procedure's `recover`,
// on a Claim token, and on an Agent or a Vertex's own Agent keys. The loader reads each named file and the validator
// records the ones each Flow uses, both from this one declaration, so a file the Pinned Configuration needs is never
// left out of it.
export const FILE_KEYS = {
  action: ['brief', 'schema', 'body', 'recoverBrief'],
  recover: ['brief'],
  claimToken: ['comment'],
  agent: ['persona'],
} satisfies Record<string, readonly string[]>;
export type FilePlace = keyof typeof FILE_KEYS;
// The file names `declared` holds at `place`'s keys, in the declaration's key order: only a non-empty string names one.
export function filesAt(place: FilePlace, declared: unknown): string[] {
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) return [];
  const values = new Map<string, unknown>(Object.entries(declared));
  return FILE_KEYS[place]
    .map((key) => values.get(key))
    .filter((name): name is string => typeof name === 'string' && name !== '');
}

// What an await-approval that declares no `decisions` accepts (request 3.3).
const DEFAULT_DECISIONS = ['approved', 'rejected'];
export function decisionsOf(action: object): string[] {
  const { decisions } = action as { decisions?: unknown };
  return Array.isArray(decisions) ? decisions.filter((decision) => typeof decision === 'string') : DEFAULT_DECISIONS;
}
// The await-approval Action of a list of Actions as declared, if it has one.
export const approvalActionOf = (actions: unknown[]) =>
  actions.find((action) => (action as { do?: unknown } | null)?.do === 'await-approval') as object | undefined;

// One Action of a Procedure as the validator resolved it: its id, its kind, and that kind's keys.
export interface Action {
  id: string;
  do: ActionKind;
  kind?: CheckKind;
  [key: string]: jsonValue.JsonValue | undefined;
}

// A Claim token (R11f): held to the Checks it requires, or a stop, which may name its comment template.
export type ClaimToken = { requires: string[]; stop?: never } | { stop: true; comment?: string; requires?: never };

// A Procedure as the Resolved Flow carries it (lib/validate/): its Actions and Claim tokens, its three Rule Tables, and
// the hash of the Procedure as declared (S6).
export interface Procedure {
  actions: Action[];
  claimTokens: Record<string, ClaimToken>;
  tests: 'frozen' | 'write' | { named: string };
  access: 'read-only' | null;
  recover: { max: number; brief: string } | null;
  passed: rules.RuleRow[];
  failed: rules.RuleRow[];
  stopped: rules.RuleRow[];
  otherwise: string | null;
  checks: string[];
  hash: string;
}

// The comparison operators, one table: the validator accepts these names, and Rule Tables and count Checks run these
// functions, so an operator added here is valid and works everywhere.
export const COMPARISONS = {
  '<': (left: number, right: number) => left < right,
  '<=': (left: number, right: number) => left <= right,
  '>': (left: number, right: number) => left > right,
  '>=': (left: number, right: number) => left >= right,
  '=': (left: number, right: number) => left === right,
};
export type Operator = keyof typeof COMPARISONS;
export const OPERATORS = Object.keys(COMPARISONS) as Operator[];
export const CONDITION_KEYS = ['field', 'is', 'none', 'any', 'all', 'count', 'where', ...OPERATORS];
export const CHECK_KEYS = {
  command: ['command', 'reuse'],
  'tests-fail': ['command', 'testNames'],
  response: [...CONDITION_KEYS, 'allOf'],
  repeat: ['list', 'fields'],
};
export type CheckKind = keyof typeof CHECK_KEYS;

// Strict like a response schema's objects, so an output and a response field of the same fields are one type.
export const object = (properties: Record<string, referencePaths.SchemaNode>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const STRING = { type: 'string' };
export const INTEGER = { type: 'integer' };
export const STRING_LIST = { type: 'array', items: STRING };
// gg's own outputs: a Check's evidence (checks.checkEvidence), an Action's cleanup (L11, L14; commandCleanup's report)
// and a Vertex's rescue (W3), whose diffStat is events.diffStats' totals.
const EVIDENCE = object({ command: STRING, output: STRING });
// A tests-fail pass found by the test's name alone says so (J8).
const RED_EVIDENCE = object({ command: STRING, output: STRING, foundByNameOnly: { type: 'boolean' } });
const CLEANUP = object({
  confirmed: { type: 'boolean' },
  survivors: {
    type: 'array',
    items: object({ pid: INTEGER, created: STRING, commandLine: STRING, error: STRING }),
  },
  reason: STRING,
  containment: object({ kind: { type: 'string', enum: ['job', 'group', 'none'] }, pgid: INTEGER }),
});
export const RESCUE = object({
  ref: STRING,
  output: STRING,
  diffStat: object({
    files: INTEGER,
    insertions: INTEGER,
    deletions: INTEGER,
    testFiles: INTEGER,
    testInsertions: INTEGER,
  }),
});
// What each Check kind produces: a command or tests-fail Check runs a command, so it declares evidence and its cleanup
// (L11); a response or repeat Check runs no command, so it has neither.
const CHECK_OUTPUTS: Record<CheckKind, Record<string, referencePaths.SchemaNode>> = {
  command: { evidence: EVIDENCE, cleanup: CLEANUP },
  'tests-fail': { evidence: RED_EVIDENCE, cleanup: CLEANUP },
  response: {},
  repeat: { findingsHash: STRING },
};

// What each Action kind produces; an agent's response is typed by its schema.
export function outputs(action: Action, schema: referencePaths.SchemaNode) {
  if (action.do === 'agent') return object({ response: schema, cleanup: CLEANUP });
  if (action.do === 'check') return object(CHECK_OUTPUTS[action.kind as CheckKind] ?? {});
  if (action.do === 'commit') return object({ files: STRING_LIST });
  // A Decision's reply is null when its actor wrote no non-blank comment after the request.
  if (action.do === 'await-approval')
    return object({ decision: object({ outcome: STRING, actor: STRING, reply: STRING }) });
  return object({});
}
