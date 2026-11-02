// The Action and Check kinds a Procedure may declare (#106): each kind's own keys, and what each Action kind produces as
// `<action id>.<output>` (W2). The Procedures themselves are configuration, declared in a Layer; the interpreter runs
// each kind.

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
// The comparison operators, one table: the validator accepts these names, and Rule Tables and count Checks run these
// functions, so an operator added here is valid and works everywhere.
export const COMPARISONS = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '=': (a, b) => a === b,
};
export const OPS = Object.keys(COMPARISONS);
export const CONDITION_KEYS = ['field', 'is', 'none', 'any', 'all', 'count', 'where', ...OPS];
export const CHECK_KEYS = {
  command: ['command', 'reuse'],
  'tests-fail': ['command', 'testNames'],
  response: [...CONDITION_KEYS, 'allOf'],
  repeat: ['list', 'fields'],
};

// Strict like a response schema's objects, so an output and a response field of the same fields are one type.
export const object = (properties) => ({
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
const CHECK_OUTPUTS = {
  command: { evidence: EVIDENCE, cleanup: CLEANUP },
  'tests-fail': { evidence: RED_EVIDENCE, cleanup: CLEANUP },
  response: {},
  repeat: { findingsHash: STRING },
};
// What each Action kind produces; an agent's response is typed by its schema.
export const outputs = (action, schema) =>
  object(
    action.do === 'agent'
      ? { response: schema, cleanup: CLEANUP }
      : action.do === 'check'
        ? (CHECK_OUTPUTS[action.kind] ?? {})
        : action.do === 'commit'
          ? { files: STRING_LIST }
          : {},
  );
