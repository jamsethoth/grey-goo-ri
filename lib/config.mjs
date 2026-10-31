import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULTS_DIR = fileURLToPath(new URL('../defaults/', import.meta.url));
export const EXAMPLES_DIR = fileURLToPath(new URL('../examples/', import.meta.url));
export const layerPath = (dir) => join(dir, '.agents', 'gg', 'gg.json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// JSON.parse keeps the last of two equal keys, so a Layer is scanned for them once it parses (ADR 0013).
function duplicateKey(text) {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:]/g) ?? [];
  const open = [];
  for (const [i, token] of tokens.entries()) {
    if (token === '{') open.push(new Set());
    else if (token === '[') open.push(null);
    else if (token === '}' || token === ']') open.pop();
    else if (tokens[i + 1] === ':') {
      const key = JSON.parse(token);
      if (open.at(-1).has(key)) return key;
      open.at(-1).add(key);
    }
  }
  return null;
}

function readLayer(file) {
  const text = readFileSync(file, 'utf8');
  const layer = JSON.parse(text);
  const key = duplicateKey(text);
  if (key !== null) throw new Error(`${file}: key "${key}" appears twice in one object`);
  return layer;
}

// A repository's unsandboxed commands and its test paths arrive whole from its own Layer: no other Layer may extend or
// narrow them (ADR 0013, ADR 0014).
function rejectRepoOnly(layer, file) {
  const key = ['commands', 'testPaths'].find((k) => Object.hasOwn(layer, k));
  if (key) throw new Error(`${file}: ${key} may be set only in a repository Layer`);
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const values = (v) => (isObject(v) ? Object.values(v) : []);

// The file names a Layer's own JSON declares, at the keys that name a file: an Agent's or inline Vertex's `persona`, an
// Action's `brief`, `schema`, `body` and `recoverBrief`, a Procedure's `recover.brief` and a Claim token's `comment`.
function declaredFiles(layer) {
  const names = [];
  const add = (v) => { if (typeof v === 'string' && v) names.push(v); };
  for (const agent of values(layer.agents)) add(agent?.persona);
  for (const flow of values(layer.flows)) for (const vertex of values(flow?.ticket?.vertices)) add(vertex?.persona);
  for (const p of values(layer.procedures)) {
    for (const a of Array.isArray(p?.actions) ? p.actions : []) for (const key of ['brief', 'schema', 'body', 'recoverBrief']) add(a?.[key]);
    add(p?.recover?.brief);
    for (const token of values(p?.claims)) add(token?.comment);
  }
  return names;
}

// Each file `layer` (read from `file`) declares, read beside `file` into `files` as { bytes, hash }. The Layer whose own
// JSON holds a name owns its file, so a later Layer that only sets an Agent's harness does not move its Persona.
// `from` records each name's path and Layer file: one name naming two files is a load error.
function loadFiles(layer, file, files, from) {
  for (const name of declaredFiles(layer)) {
    const path = resolve(dirname(file), name);
    if (Object.hasOwn(from, name)) {
      if (from[name].path !== path) throw new Error(`file ${JSON.stringify(name)} is declared by ${from[name].file} and by ${file}, each beside its own Layer; give one of them another name`);
      continue;
    }
    let bytes;
    try {
      bytes = readFileSync(path, 'utf8');
    } catch (e) {
      throw new Error(`${file} names file ${JSON.stringify(name)}, which cannot be read (${e.code ?? e.message})`);
    }
    from[name] = { path, file };
    files[name] = { bytes, hash: sha256(bytes) };
  }
}

function readDefaults(files, from) {
  const file = join(DEFAULTS_DIR, 'gg.json');
  const config = readLayer(file);
  rejectRepoOnly(config, file);
  loadFiles(config, file, files, from);
  return config;
}

// The shipped Layer: defaults/gg.json plus the bytes and hash of every file it names (`files`).
export function loadDefaults() {
  const files = {};
  return { ...readDefaults(files, {}), files };
}

// Objects merge key by key at every depth; anything else in the later Layer replaces the earlier value.
const merge = (base, layer) => (isObject(base) && isObject(layer)
  ? Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(layer)])].map((k) => [k, Object.hasOwn(layer, k) ? merge(base[k], layer[k]) : base[k]]))
  : layer);

// defaults < user < repo, with the files each Layer names. `files` is gg's own: no Layer sets it.
// shortcut: a plain deep merge; slice 5 brings the migration table.
export function loadConfig(repoRoot, home = homedir()) {
  const files = {};
  const from = {};
  let config = readDefaults(files, from);
  for (const dir of [home, repoRoot]) {
    const p = layerPath(dir);
    if (!existsSync(p)) continue;
    const layer = readLayer(p);
    if (dir === home) rejectRepoOnly(layer, p);
    loadFiles(layer, p, files, from);
    config = merge(config, layer);
  }
  return { ...config, files };
}

// A file a Layer named, by that name (loadConfig's `files`).
export function layerFile(files, name) {
  if (!isObject(files) || !Object.hasOwn(files, name)) throw new Error(`no Layer names file ${JSON.stringify(name)}`);
  return files[name].bytes;
}

// Sorted keys at every depth, so the hash ignores key order.
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
    : value;

// The Pinned Configuration's hash: the Resolved Flow and every Layer file by name, never by path (no install path enters it).
export function configHash({ flow, files, harnesses, launchProfile = null, commands, testPaths }) {
  return sha256(JSON.stringify(canonical({ flow, files, harnesses, launchProfile, commands, testPaths })));
}

// Only globs that git's pathspecs (rollback) and checks.testPathMatcher (Test Immutability) read alike, and that git
// accepts inside the repository: git's `?` takes one byte of a UTF-8 name, and its brackets and backslash are syntax.
const badGlob = (g) => typeof g !== 'string' || !g.trim() || /[[\]?\\:\x00-\x1f]/.test(g)
  || g.split('/').some((s) => !s || s === '.' || s === '..' || (s.includes('**') && s !== '**'));

// The repository Layer's testPaths as preflight failures, each naming `file`; none for a non-empty list of globs.
export function testPathsProblems(testPaths, file) {
  if (testPaths === undefined) return [`${file} declares no testPaths; merge {"testPaths":["<glob>"]} into it`];
  if (!Array.isArray(testPaths) || !testPaths.length) return [`${file}: testPaths must be a non-empty list of glob strings`];
  return testPaths.filter(badGlob).map((g) => `${file}: testPaths entry ${JSON.stringify(g)} must be a glob relative to the repository root: `
    + 'non-empty segments split by "/", no "." or ".." segment, "**" only as a whole segment, and no [ ] ? \\ : or control character');
}

// The repository Layer's Declared Commands as preflight failures, each naming `file`; none for a valid set with a test.
export function commandProblems(commands, file) {
  if (commands === undefined) commands = {};
  if (!isObject(commands)) return [`${file}: commands must be an object from name to command line`];
  const problems = [];
  for (const [name, line] of Object.entries(commands)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) problems.push(`${file}: command name "${name}" must match [a-z][a-z0-9-]*`);
    else if (typeof line !== 'string' || !line.trim() || /[\r\n]/.test(line)) problems.push(`${file}: command ${name} must be a non-empty single-line string`);
  }
  if (!Object.hasOwn(commands, 'test')) problems.push(`${file} declares no test command; merge {"commands":{"test":"<command line>"}} into it`);
  return problems;
}
