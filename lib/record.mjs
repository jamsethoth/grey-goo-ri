import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const SCHEMA_VERSION = 1;

export class RecordCorruptError extends Error {
  constructor(file, reason) {
    super(`corrupt record ${file}: ${reason}`);
    this.name = 'RecordCorruptError';
    this.file = file;
  }
}

function recordsDir(commonDir) {
  return join(commonDir, 'gg', 'records');
}

function recordPath(commonDir, kind, n) {
  return join(recordsDir(commonDir), `${kind}-${n}.json`);
}

export function createExecution({ commonDir, ticket, epic, flow, configHash, run, worktree, branch, base }) {
  return {
    schemaVersion: SCHEMA_VERSION, commonDir,
    execution: `${ticket}.${randomBytes(3).toString('hex')}`,
    ticket, epic, flow: flow.name, configHash, run,
    state: 'active',
    cursor: { vertex: flow.entry, visit: 1, phase: null, ordinal: 0, attempt: 1 },
    visits: {}, traversals: {}, retries: {}, sessions: {},
    outputs: { red: null, implementation: [], reviews: [] },
    history: [], worktree, branch, base, pr: null, pending: null, snapshot: null,
    activity: { busy: false, generation: 0 },
    log: [],
  };
}

export function createEpicRecord({ commonDir, epic }) {
  return { schemaVersion: SCHEMA_VERSION, commonDir, epic, approval: null, pending: null };
}

export async function save(record) {
  const { commonDir, ...data } = record;
  const kind = 'execution' in record ? 'ticket' : 'epic';
  const path = recordPath(commonDir, kind, kind === 'ticket' ? record.ticket : record.epic);
  await mkdir(recordsDir(commonDir), { recursive: true });
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2) + '\n');
  await rename(temp, path);
}

async function loadFile(commonDir, path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new RecordCorruptError(path, err.message);
  }
  if (data?.schemaVersion !== SCHEMA_VERSION) throw new RecordCorruptError(path, `unknown schemaVersion ${data?.schemaVersion}`);
  return { ...data, commonDir };
}

export function load(commonDir, kind, n) {
  return loadFile(commonDir, recordPath(commonDir, kind, n));
}

export async function loadAll(commonDir, kind) {
  let names;
  try {
    names = await readdir(recordsDir(commonDir));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const pattern = new RegExp(`^${kind}-\\d+\\.json$`);
  const records = await Promise.all(names.filter((name) => pattern.test(name))
    .map((name) => loadFile(commonDir, join(recordsDir(commonDir), name))));
  return records.filter(Boolean);
}

function append(record, marker, step, action, fields) {
  record.log.push({ step, marker, action, ...fields, ts: new Date().toISOString() });
  return save(record);
}

function actionOf(record, marker) {
  return record.log.find((e) => e.marker === marker && e.step === 'intent')?.action ?? null;
}

export function intent(record, marker, action, payload) {
  return append(record, marker, 'intent', action, { payload });
}

export function evidence(record, marker, evidence) {
  return append(record, marker, 'evidence', actionOf(record, marker), { evidence });
}

export function complete(record, marker) {
  return append(record, marker, 'complete', actionOf(record, marker), {});
}

export function openIntents(record) {
  const done = new Set(record.log.filter((e) => e.step === 'complete').map((e) => e.marker));
  return record.log.filter((e) => e.step === 'intent' && !done.has(e.marker));
}
