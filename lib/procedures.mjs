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
export const OPS = ['<', '<=', '>', '>=', '='];
export const CONDITION_KEYS = ['field', 'is', 'none', 'any', 'all', 'count', 'where', ...OPS];
export const CHECK_KEYS = {
  command: ['command', 'reuse'],
  'tests-fail': ['command', 'names'],
  response: [...CONDITION_KEYS, 'all-of'],
  repeat: ['list', 'fields'],
};

// Strict like a response schema's objects, so an output and a response field of the same fields are one type.
export const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
export const STRING = { type: 'string' };
export const INTEGER = { type: 'integer' };
export const STRING_LIST = { type: 'array', items: STRING };
// gg's own outputs: a Check's evidence (checks.evidence), an Action's cleanup (L11, exec's survivors) and a Vertex's
// rescue (W3), whose diffStat is events.diffStats' totals.
const EVIDENCE = object({ command: STRING, output: STRING });
// A tests-fail pass found by the test's name alone says so (J8).
const RED_EVIDENCE = object({ command: STRING, output: STRING, heuristic: { type: 'boolean' } });
const CLEANUP = object({ confirmed: { type: 'boolean' }, survivors: { type: 'array', items: object({ pid: INTEGER, error: STRING }) } });
export const RESCUE = object({ ref: STRING, output: STRING,
  diffStat: object({ files: INTEGER, insertions: INTEGER, deletions: INTEGER, testFiles: INTEGER, testInsertions: INTEGER }) });
// What each Action kind produces; an agent's response is typed by its schema.
export const outputs = (action, schema) => object(action.do === 'agent' ? { response: schema, cleanup: CLEANUP }
  : action.do === 'check' ? { evidence: action.kind === 'tests-fail' ? RED_EVIDENCE : EVIDENCE, cleanup: CLEANUP }
    : action.do === 'commit' ? { files: STRING_LIST } : {});
