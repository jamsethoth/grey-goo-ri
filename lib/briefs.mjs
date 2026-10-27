// Briefs and Structured Response schemas for every Phase.
// Schemas are strict (every property required, no extras) because Codex's --output-schema demands it.

import { publicTail } from './render.mjs';

const str = { type: 'string' };
const strs = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

const claim = { type: 'string', enum: ['ok', 'blocked', 'misscoped'] };

// Red phase: failing tests only. The orchestrator verifies they fail and commits them.
export const RED_SCHEMA = obj({ claim, summary: str, tests: strs, notes: str, diagnosis: str });

// Green phase, fix rounds, still-green and test-fix: the orchestrator runs the tests and records evidence itself.
export const IMPLEMENT_SCHEMA = obj({
  claim,
  summary: str,
  dod: { type: 'array', items: obj({ item: str, met: { type: 'boolean' }, evidence: str }) },
  qa: obj({ setup: str, steps: { type: 'array', items: obj({ action: str, expected: str }) }, edgeCases: strs, automated: strs, manual: strs }),
  diagnosis: str,
  notes: str,
});

export const REVIEW_SCHEMA = obj({
  claim: { type: 'string', enum: ['ok', 'changes', 'misscoped'] },
  summary: str,
  dodMet: { type: 'boolean' },
  tddEvidenceOk: { type: 'boolean' },
  findings: { type: 'array', items: obj({ severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, file: str, issue: str, fix: str }) },
  diagnosis: str,
});

// The strict subset both harnesses' structured output accepts; any other keyword or type is refused at load.
const SUBSET = {
  object: ['type', 'properties', 'required', 'additionalProperties'],
  array: ['type', 'items'],
  string: ['type', 'enum'],
  boolean: ['type'],
  integer: ['type'],
};

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const repeated = (list) => list.find((v, i) => list.indexOf(v) !== i);

export function assertStrict(schema, path = '(root)') {
  if (!isRecord(schema)) throw new Error(`${path}: schema must be an object`);
  // A string test first: SUBSET[['string']] would coerce the array to its one element.
  const keywords = typeof schema.type === 'string' && Object.hasOwn(SUBSET, schema.type) ? SUBSET[schema.type] : null;
  const keyword = Object.keys(schema).find((k) => !(keywords ?? ['type']).includes(k));
  if (keyword !== undefined) throw new Error(`${path}: keyword ${JSON.stringify(keyword)} is outside the strict subset`);
  if (!keywords) throw new Error(`${path}: type ${JSON.stringify(schema.type) ?? '(none)'} is outside the strict subset`);
  if (Object.hasOwn(schema, 'enum') && !(Array.isArray(schema.enum) && schema.enum.length && schema.enum.every((v) => typeof v === 'string'))) {
    throw new Error(`${path}: enum must be a non-empty list of strings`);
  }
  const repeatedValue = schema.enum && repeated(schema.enum);
  if (repeatedValue !== undefined) throw new Error(`${path}: enum repeats ${JSON.stringify(repeatedValue)}`);
  if (schema.type === 'array' && schema.items === undefined) throw new Error(`${path}: array lacks items`);
  if (schema.type === 'object') {
    const keys = Object.keys(schema.properties ?? {});
    if (schema.properties !== undefined && !isRecord(schema.properties)) throw new Error(`${path}: properties must be an object`);
    if (schema.additionalProperties !== false) throw new Error(`${path}: object lacks additionalProperties: false`);
    if (!Array.isArray(schema.required)) throw new Error(`${path}: required must be a list`);
    const repeatedName = repeated(schema.required);
    if (repeatedName !== undefined) throw new Error(`${path}: required repeats ${JSON.stringify(repeatedName)}`);
    const missing = keys.find((k) => !schema.required.includes(k));
    if (missing !== undefined) throw new Error(`${path}: required lacks property ${JSON.stringify(missing)}`);
    const extra = schema.required.find((k) => !keys.includes(k));
    if (extra !== undefined) throw new Error(`${path}: required names ${JSON.stringify(extra)}, which is not a property`);
    const unreachable = keys.find((k) => k === '' || k.includes('.'));
    if (unreachable !== undefined) throw new Error(`${path}: property name ${JSON.stringify(unreachable)} cannot be reached by a dotted path`);
    for (const k of keys) assertStrict(schema.properties[k], `${path}.${k}`);
  }
  if (schema.type === 'array') assertStrict(schema.items, `${path}[]`);
}

function mismatch(schema, value, path) {
  if (schema.type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return `${path} must be an object`;
    for (const k of schema.required) {
      if (!Object.hasOwn(value, k)) return `${path ? `${path}.` : ''}${k} is missing`;
      const reason = mismatch(schema.properties[k], value[k], path ? `${path}.${k}` : k);
      if (reason) return reason;
    }
    const extra = Object.keys(value).find((k) => !Object.hasOwn(schema.properties ?? {}, k));
    return extra !== undefined ? `${path ? `${path}.` : ''}${extra} is not in the schema` : null;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    for (let i = 0; i < value.length; i++) {
      const reason = mismatch(schema.items, value[i], `${path}[${i}]`);
      if (reason) return reason;
    }
    return null;
  }
  if (schema.type === 'integer') return Number.isInteger(value) ? null : `${path} must be an integer`;
  if (typeof value !== schema.type) return `${path} must be a ${schema.type}`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of ${schema.enum.join(' | ')}`;
  return null;
}

export function validateResponse(schema, response) {
  if (response == null) return { valid: false, reason: 'no structured response' };
  const reason = mismatch(schema, response, '');
  return reason ? { valid: false, reason } : { valid: true, claim: response.claim };
}

const quoted = (list) => (list.length ? list.map((v) => JSON.stringify(v)).join(' | ') : '(none)');

// V1: tokens are matched exactly, so values that differ only in case would be a Claim nobody can route.
export function assertClaimEnum(schema, tokens) {
  const values = schema?.properties?.claim?.enum;
  if (!values) throw new Error('claim: the schema has no claim enum');
  assertStrict(schema.properties.claim, 'claim');
  if (!Array.isArray(tokens) || !tokens.every((t) => typeof t === 'string')) {
    throw new Error('claim: the declared tokens must be a list of strings');
  }
  for (const list of [values, tokens]) {
    if (new Set(list.map((v) => v.toLowerCase())).size !== list.length) throw new Error(`claim: ${quoted(list)} repeats a value or differs only in case`);
  }
  const missing = tokens.filter((t) => !values.includes(t));
  if (!missing.length && values.length === tokens.length) return;
  const caseOnly = missing.some((t) => values.some((v) => v.toLowerCase() === t.toLowerCase()));
  throw new Error(`claim: enum ${quoted(values)} does not equal the declared tokens ${quoted(tokens)}${caseOnly ? ' (they differ in case)' : ''}`);
}

const kindOf = (s) => (s.type === 'array' ? { kind: 'list', of: kindOf(s.items) } : s.enum ? { kind: 'enum', values: s.enum } : { kind: s.type });

// A path steps through arrays implicitly: findings.severity is a list of the severity enum.
export function fieldType(schema, path) {
  // Only the type: a YAML value may be self-referencing or lack a callable toString.
  if (typeof path !== 'string') return { error: `the field path must be a string, not ${path === null ? 'null' : typeof path}` };
  try {
    assertStrict(schema);
  } catch (e) {
    return { error: `${JSON.stringify(path)}: the schema is outside the strict subset (${e.message})` };
  }
  if (path === '') return { error: 'the field path is empty' };
  const steps = path.split('.');
  if (steps.includes('')) return { error: `${JSON.stringify(path)} has an empty segment` };
  let node = schema;
  let lists = 0;
  for (const [i, key] of steps.entries()) {
    while (node.type === 'array') { node = node.items; lists++; }
    if (node.type !== 'object' || !Object.hasOwn(node.properties ?? {}, key)) {
      const prefix = steps.slice(0, i + 1).join('.');
      return { error: `${prefix === path ? '' : `${JSON.stringify(path)}: `}${JSON.stringify(prefix)} is not a field of the schema` };
    }
    node = node.properties[key];
  }
  let type = kindOf(node);
  for (; lists > 0; lists--) type = { kind: 'list', of: type };
  return type;
}

// Agent-to-agent text may be compressed; anything a human reads stays natural.
export function styleBlock(style, cavemanRules) {
  const level = /^caveman-(lite|full|ultra)$/.exec(style?.internal ?? '')?.[1];
  const human = 'Every other field is read by a human: concise, plain, natural sentences; no filler; never caveman.';
  if (!level || !cavemanRules) return `\n## Writing style\n${human}\n`;
  return `
## Writing style
- Your working prose (reasoning shown between tool calls) and the \`notes\` field are read only by other agents:
  write them caveman-style at the **${level}** intensity of the rules below.
- ${human} Code, commands, paths and error strings stay exact everywhere.

### Caveman rules
${cavemanRules}
`;
}

const commandsBlock = (commands) =>
  Object.keys(commands).length ? Object.entries(commands).map(([k, v]) => `- ${k}: \`${v}\``).join('\n') : '- (none declared)';

const context = ({ ticket, base, commands }) => `GitHub issue #${ticket.number}: ${ticket.title}

You are on branch ${ticket.branch}, created from ${base}. Work only here.

## Ticket
${ticket.body}

## Repo commands
${commandsBlock(commands)}

## Rules
- Do not run git add, git commit, git push or gh: the orchestrator runs the tests, commits and handles GitHub.
- Run repo commands plainly, without command substitution or heredocs: they are permission-checked.
- Stay inside the ticket's scope.`;

const historyBlock = (history = []) => history.length
  ? `\n## Previous attempts on this branch (newest last)\n${history.map((h, i) => `### Attempt ${i + 1}: ${h.kind}\n${h.text}`).join('\n\n')}\n`
  : '';

const COMMITTED_TESTS = `Committed tests must not be changed. If one is genuinely wrong, say why in notes: claim ok only if
the implementation still passes it as written, otherwise claim blocked.`;

const IMPLEMENT_REPORT = `Return the structured result: claim ok, blocked or misscoped; every definition-of-done item with evidence,
QA instructions, and notes. "diagnosis" is empty unless your claim is misscoped or your persona asks for one.`;

export function redBrief(opts) {
  return `RED PHASE for ${context(opts)}
${historyBlock(opts.history)}
Write the failing tests that prove this ticket's definition of done (start from "Tests to write first").
Do NOT write any implementation code yet. Run the test command and confirm the new tests fail for the right reason.
Return the structured result: claim ok, blocked or misscoped; in "tests", the exact names of the failing tests you
wrote, as the test runner prints them; and why they fail. "diagnosis" is empty unless your claim is misscoped.`;
}

export function greenBrief(opts) {
  return `GREEN PHASE for ${context(opts)}

## Committed tests
${opts.testFiles.map((f) => `- ${f}`).join('\n')}

The orchestrator committed these failing tests; the test command failed as expected:

\`\`\`
${publicTail(opts.redOutput, String, 4000)}
\`\`\`

Write the smallest implementation that makes them pass and meets every definition-of-done item.
${COMMITTED_TESTS}
Finish with the test command passing.
${IMPLEMENT_REPORT}`;
}

export function fixBrief(opts) {
  return `FIX ROUND for ${context(opts)}
${historyBlock(opts.history)}
The branch already holds the previous work. Address every blocker and major finding above.
If a fix changes behaviour, add or adjust a failing test first. Finish with the test command passing.
${IMPLEMENT_REPORT}`;
}

export function reviewBrief({ ticket, base, commands, impl, diff, changedTestFiles = [] }) {
  const changed = changedTestFiles.length
    ? `\n## Test files changed since the red commit\n${changedTestFiles.map((f) => `- ${f}`).join('\n')}\n`
    : '';
  return `Review the change on branch ${ticket.branch} (against ${base}) for GitHub issue #${ticket.number}: ${ticket.title}
Read-only: do not modify files.

## Ticket (includes the definition of done)
${ticket.body}

## Repo commands
${commandsBlock(commands)}

## Diff
\`\`\`diff
${diff}
\`\`\`
${changed}
## Implementer's report
${JSON.stringify(impl, null, 2)}

Check correctness, code quality and simplicity, and definition-of-done coverage. The orchestrator itself verified
that the "test:" commit's tests failed before implementation and pass now (outputs are in the report); check that
those tests actually exercise the ticket's behaviour and were not weakened afterwards.
Return claim ok only if there are no blocker or major findings, changes otherwise, or misscoped with a diagnosis
when the ticket itself cannot be met as written.`;
}

export function testFixBrief({ ticket, commands, output }) {
  return `The orchestrator ran the test command on branch ${ticket.branch} after your work and it FAILED:\n\n\`\`\`\n${publicTail(output, String, 6000)}\n\`\`\`\n\n## Repo commands\n${commandsBlock(commands)}\n\nMake the test command pass.\n${COMMITTED_TESTS}`;
}

// The parse-failure retry resumes the same Session, so it needs only the nudge, not the full Brief again.
export const nudgeBrief = (reason) => `Your last turn did not return a valid structured result (${reason}). Return the structured result now, in the required schema, with exactly one claim token.`;

export function stillGreenBrief({ ticket, commands, output }) {
  return `The orchestrator ran the test command on branch ${ticket.branch} after your red phase and it PASSED, so your new tests do not fail yet:\n\n\`\`\`\n${publicTail(output, String)}\n\`\`\`\n\n## Repo commands\n${commandsBlock(commands)}\n\nWrite tests that fail until the ticket is implemented. Do not implement anything.`;
}
