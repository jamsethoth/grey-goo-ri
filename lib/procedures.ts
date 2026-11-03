// The Action and Check kinds a Procedure may declare (#106): each kind's own keys, and what each Action kind produces
// as `<action id>.<output>` (W2). The Procedures themselves are configuration, declared in a Layer; the interpreter
// runs each kind.

import type * as refs from './refs.ts';
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

// One Action of a Procedure as the validator resolved it: its id, its kind, and that kind's keys.
export interface Action {
  id: string;
  do: ActionKind;
  kind?: CheckKind;
  [key: string]: unknown;
}

// A Claim token (R11f): held to the Checks it requires, or a stop, which may name its comment template.
export type ClaimToken = { requires: string[]; stop?: never } | { stop: true; comment?: string; requires?: never };

// A Procedure as the Resolved Flow carries it (validate.mjs): its Actions and Claim tokens, its three Rule Tables, and
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
export const OPS = Object.keys(COMPARISONS) as Operator[];
export const CONDITION_KEYS = ['field', 'is', 'none', 'any', 'all', 'count', 'where', ...OPS];
export const CHECK_KEYS = {
  command: ['command', 'reuse'],
  'tests-fail': ['command', 'testNames'],
  response: [...CONDITION_KEYS, 'allOf'],
  repeat: ['list', 'fields'],
};
export type CheckKind = keyof typeof CHECK_KEYS;

// Strict like a response schema's objects, so an output and a response field of the same fields are one type.
export const object = (properties: Record<string, refs.SchemaNode>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
export const STRING = { type: 'string' };
export const INTEGER = { type: 'integer' };
export const STRING_LIST = { type: 'array', items: STRING };
// gg's own outputs: a Check's evidence (checks.evidence), an Action's cleanup (L11, exec's survivors) and a Vertex's
// rescue (W3), whose diffStat is events.diffStats' totals.
const EVIDENCE = object({ command: STRING, output: STRING });
// A tests-fail pass found by the test's name alone says so (J8).
const RED_EVIDENCE = object({ command: STRING, output: STRING, foundByNameOnly: { type: 'boolean' } });
const CLEANUP = object({
  confirmed: { type: 'boolean' },
  survivors: { type: 'array', items: object({ pid: INTEGER, error: STRING }) },
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
// What each Check kind produces: a command or tests-fail Check runs a command, so it declares evidence and the cleanup
// L11 will write; a response or repeat Check runs no command, so it has neither.
const CHECK_OUTPUTS: Record<CheckKind, Record<string, refs.SchemaNode>> = {
  command: { evidence: EVIDENCE, cleanup: CLEANUP },
  'tests-fail': { evidence: RED_EVIDENCE, cleanup: CLEANUP },
  response: {},
  repeat: { findingsHash: STRING },
};

// What each Action kind produces; an agent's response is typed by its schema.
export function outputs(action: Action, schema: refs.SchemaNode) {
  if (action.do === 'agent') return object({ response: schema, cleanup: CLEANUP });
  if (action.do === 'check') return object(CHECK_OUTPUTS[action.kind as CheckKind] ?? {});
  if (action.do === 'commit') return object({ files: STRING_LIST });
  return object({});
}
