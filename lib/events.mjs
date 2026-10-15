// Append-only event log, schema 2: one JSON object per line in <git common dir>/gg/events.jsonl.
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const eventsFile = (commonDir) => join(commonDir, 'gg', 'events.jsonl');

export function eventLog(commonDir, base = {}) {
  mkdirSync(join(commonDir, 'gg'), { recursive: true });
  return (type, data = {}) =>
    appendFileSync(eventsFile(commonDir), JSON.stringify({ schema: 2, ts: new Date().toISOString(), type, ...base, ...data }) + '\n');
}

// A line without `schema` predates schema 2 and is kept as schema 1.
export function readEvents(commonDir) {
  const f = eventsFile(commonDir);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).map((e) => ({ schema: 1, ...e }));
}

function closed(what, fields, required, optional = []) {
  for (const key of required) if (!(key in fields)) throw new Error(`${what}: missing required field ${key}`);
  const known = new Set([...required, ...optional]);
  for (const key of Object.keys(fields)) if (!known.has(key)) throw new Error(`${what}: unknown field ${key}`);
}

const ACTION_REQUIRED = [
  'flow', 'configHash', 'launchProfile', 'confinement', 'ticket', 'run', 'execution', 'vertex', 'visit',
  'procedure', 'phase', 'ordinal', 'attempt', 'durationMs', 'outcome', 'direction', 'signals', 'rule',
];
const AGENT_REQUIRED = [
  'harness', 'cliVersion', 'model', 'effort', 'personaHash', 'tools', 'init', 'sessionId', 'lineage',
  'transcriptPath', 'usage', 'exitCode', 'signal', 'finalEventSubtype', 'permissionDenials', 'commandsRun',
  'failureClass',
];
const ACTION_OPTIONAL = ['agent', 'check', 'violations', 'requireTestPass', 'repeat', 'exhausted', 'retryAfterMs', 'error'];

export function actionEvent(fields) {
  const agent = fields.agent === true;
  closed('action event', fields, agent ? [...ACTION_REQUIRED, ...AGENT_REQUIRED] : ACTION_REQUIRED, ACTION_OPTIONAL);
  return { type: 'action', ...fields };
}

const LIFECYCLE = {
  run_start: { required: ['run'] },
  run_end: { required: ['run'] },
  ticket_start: { required: ['run', 'execution', 'ticket'] },
  ticket_end: { required: ['run', 'execution', 'ticket'] },
  label_failed: { required: ['ticket', 'change', 'error'], optional: ['run'] },
};

export function lifecycleEvent(type, fields = {}) {
  const spec = LIFECYCLE[type];
  if (!spec) throw new Error(`unknown lifecycle event type ${type}`);
  closed(`${type} event`, fields, spec.required, spec.optional);
  return { type, ...fields };
}

const TEST_PATH = /(^|\/)(tests?|spec|__tests__)\/|\.(test|spec)\.[^/]+$/i;
// `git diff --numstat` lines -> totals, split into test and non-test files.
export function diffStats(numstat) {
  const s = { files: 0, insertions: 0, deletions: 0, testFiles: 0, testInsertions: 0 };
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [add, del, path] = line.split('\t');
    const a = Number(add) || 0;
    s.files++; s.insertions += a; s.deletions += Number(del) || 0;
    if (TEST_PATH.test(path)) { s.testFiles++; s.testInsertions += a; }
  }
  return s;
}
