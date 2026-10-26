import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULTS_DIR = fileURLToPath(new URL('../defaults/', import.meta.url));
export const EXAMPLES_DIR = fileURLToPath(new URL('../examples/', import.meta.url));
export const PERSONAS_DIR = join(DEFAULTS_DIR, 'personas');
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

// The shipped Layer: defaults/gg.json plus the bytes and hash of every Persona its Agents name.
export function loadDefaults() {
  const file = join(DEFAULTS_DIR, 'gg.json');
  const config = readLayer(file);
  rejectRepoOnly(config, file);
  const personas = {};
  for (const { persona } of Object.values(config.agents)) {
    const bytes = readFileSync(join(PERSONAS_DIR, persona), 'utf8');
    personas[persona] = { bytes, hash: sha256(bytes) };
  }
  return { ...config, personas };
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// Objects merge key by key at every depth; anything else in the later Layer replaces the earlier value.
const merge = (base, layer) => (isObject(base) && isObject(layer)
  ? Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(layer)])].map((k) => [k, Object.hasOwn(layer, k) ? merge(base[k], layer[k]) : base[k]]))
  : layer);

// shortcut: defaults < user < repo with a plain deep merge and shipped Personas only; slice 5 brings the migration table and Layer Personas.
export function loadConfig(repoRoot, home = homedir()) {
  let config = loadDefaults();
  for (const dir of [home, repoRoot]) {
    const p = layerPath(dir);
    if (!existsSync(p)) continue;
    const layer = readLayer(p);
    if (dir === home) rejectRepoOnly(layer, p);
    config = merge(config, layer);
  }
  return config;
}

// Sorted keys at every depth, so the hash ignores key order.
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
    : value;

export function configHash({ flow, personas, harnesses, launchProfile = null, commands, testPaths }) {
  return sha256(JSON.stringify(canonical({ flow, personas, harnesses, launchProfile, commands, testPaths })));
}

// The repository Layer's testPaths as preflight failures, each naming `file`; none for a non-empty list of globs.
export function testPathsProblems(testPaths, file) {
  if (testPaths === undefined) return [`${file} declares no testPaths; merge {"testPaths":["<glob>"]} into it`];
  if (!Array.isArray(testPaths) || !testPaths.length) return [`${file}: testPaths must be a non-empty list of glob strings`];
  return testPaths.filter((g) => typeof g !== 'string' || !g.trim() || /[\r\n]/.test(g))
    .map((g) => `${file}: testPaths entry ${JSON.stringify(g)} must be a non-empty single-line glob string`);
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
