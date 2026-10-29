// Append-only event log, schema 2: one row per Event in the events table of the State Database.
import * as checks from './checks.mjs';
import * as record from './record.mjs';

let beforeAppend = () => {};
// Tests fail chosen appends, as a disk error would: the hook sees each Event about to be inserted and throws to fail
// that insert. Returns the previous hook to put back.
export const setAppendHook = (fn) => { const previous = beforeAppend; beforeAppend = fn; return previous; };

export function eventLog(commonDir, base = {}) {
  return (type, data = {}) => {
    // `data` may be the output of actionEvent or lifecycleEvent, which already carries a matching `type`.
    const { type: own = type, ...fields } = { ...base, ...data };
    if (own !== type) throw new Error(`${type} event: field type is ${own}`);
    const event = { schema: 2, ts: new Date().toISOString(), ...(type === 'action' ? actionEvent(fields) : lifecycleEvent(type, fields)) };
    beforeAppend(event);
    record.openDb(commonDir).prepare('INSERT INTO events (ts, type, run, execution, ticket, json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(event.ts, event.type, event.run ?? null, event.execution ?? null, event.ticket ?? null, JSON.stringify(event));
  };
}

export function readEvents(commonDir) {
  return record.openDb(commonDir).prepare('SELECT json FROM events ORDER BY id').all().map((row) => JSON.parse(row.json));
}

// An Execution's Terminal has landed once its ticket_end is in the log.
export const hasTicketEnd = (commonDir, execution) =>
  !!record.openDb(commonDir).prepare("SELECT 1 FROM events WHERE execution = ? AND type = 'ticket_end' LIMIT 1").get(execution);

function closed(what, fields, required, optional = []) {
  // An undefined value would vanish in JSON, so it counts as missing; null is a declared absence and stays.
  for (const key of required) if (!Object.hasOwn(fields, key) || fields[key] === undefined) throw new Error(`${what}: missing required field ${key}`);
  const known = new Set([...required, ...optional]);
  for (const key of Object.keys(fields)) if (!known.has(key)) throw new Error(`${what}: unknown field ${key}`);
}

const ACTION_REQUIRED = [
  'flow', 'configHash', 'launchProfile', 'confinement', 'ticket', 'run', 'execution', 'vertex', 'visit',
  'procedure', 'action', 'recovery', 'attempt', 'durationMs', 'outcome', 'direction', 'signals', 'rule',
];
const AGENT_REQUIRED = [
  'harness', 'cliVersion', 'model', 'effort', 'personaHash', 'tools', 'init', 'sessionId', 'lineage',
  'transcriptPath', 'usage', 'exitCode', 'signal', 'finalEventSubtype', 'permissionDenials', 'commandsRun',
  'failureClass',
];
const ACTION_OPTIONAL = ['agent', 'check', 'violations', 'exhausted', 'retryAfterMs', 'error'];

export function actionEvent(fields) {
  const agent = fields.agent === true;
  closed('action event', fields, agent ? [...ACTION_REQUIRED, ...AGENT_REQUIRED] : ACTION_REQUIRED, ACTION_OPTIONAL);
  if (agent) for (const member of ['cumulative', 'delta']) checkUsage(fields.usage, member);
  return { type: 'action', ...fields };
}

// shortcut: checks only the Usage keys this ticket names, without closing the shape; T8 owns the full Usage shape.
const USAGE_KEYS = ['peakContext', 'turns', 'toolCalls', 'compactions', 'costUsd'];
function checkUsage(usage, member) {
  const u = usage?.[member];
  if (u === null || typeof u !== 'object') throw new Error(`action event: usage.${member} must be a Usage object`);
  for (const key of USAGE_KEYS) {
    if (!(u[key] === null || typeof u[key] === 'number')) throw new Error(`action event: usage.${member}.${key} must be a number or null`);
  }
}

const LIFECYCLE = {
  run_start: { required: ['run'] },
  run_end: { required: ['run'], optional: ['tickets', 'failureClass'] },
  ticket_start: { required: ['run', 'execution', 'ticket'] },
  ticket_end: { required: ['run', 'execution', 'ticket'], optional: ['outcome', 'diffStats', 'reason', 'error', 'interrupted'] },
  label_failed: { required: ['ticket', 'change', 'error'], optional: ['run'] },
};

export function lifecycleEvent(type, fields = {}) {
  const spec = LIFECYCLE[type];
  if (!spec) throw new Error(`unknown lifecycle event type ${type}`);
  closed(`${type} event`, fields, spec.required, spec.optional);
  return { type, ...fields };
}

// Per-file line counts (git.diffStats; a binary file's are null) -> totals, split into test and non-test files by the
// pinned testPaths.
export function diffStats(files, testPaths) {
  const isTest = checks.testPathMatcher(testPaths);
  const s = { files: 0, insertions: 0, deletions: 0, testFiles: 0, testInsertions: 0 };
  for (const { path, insertions, deletions } of files) {
    const a = insertions ?? 0;
    s.files++; s.insertions += a; s.deletions += deletions ?? 0;
    if (isTest(path)) { s.testFiles++; s.testInsertions += a; }
  }
  return s;
}
