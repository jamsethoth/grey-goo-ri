import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsonc from 'jsonc-parser';
import * as referencePaths from './reference-paths.ts';
import * as report from './validate/report.ts';

export const DEFAULTS_DIRECTORY = fileURLToPath(new URL('../defaults/', import.meta.url));
export const EXAMPLES_DIRECTORY = fileURLToPath(new URL('../examples/', import.meta.url));
export const layerPath = (directory: string): string => join(directory, '.agents', 'gg', 'gg.json');

type Layer = Record<string, unknown>;
// Each file a Layer named, by that name: its text and the hash the Config Hash takes of it.
export type LayerFiles = Record<string, { bytes: string; hash: string }>;
// Where each name's file was read from, and the Layer file that named it.
type FileSources = Record<string, { path: string; file: string }>;
// The merged Layers as gg reads them. The defaults Layer sets every field typed here; the validator checks the rest.
export interface Config {
  files: LayerFiles;
  labelPrefix: string;
  baseBranch: string;
  worktreeRoot: string;
  maxParallel: number;
  commands?: unknown;
  testPaths?: unknown;
  approvers?: unknown;
  harnesses?: unknown;
  [key: string]: unknown;
}

// The one hash gg takes of bytes or text: file hashes, the Config Hash, body hashes and digests.
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// JSON.parse keeps the last of two equal keys, so a Layer is scanned for them once it parses (ADR 0013).
function duplicateKey(text: string): string | null {
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|[{}[\]:]/g) ?? [];
  const open: (Set<string> | null)[] = [];
  for (const [index, token] of tokens.entries()) {
    if (token === '{') open.push(new Set());
    else if (token === '[') open.push(null);
    else if (token === '}' || token === ']') open.pop();
    else if (tokens[index + 1] === ':') {
      const key: string = JSON.parse(token);
      // Text that parses as JSON has a key followed by a colon only inside an object.
      const keys = open.at(-1) as Set<string>;
      if (keys.has(key)) return key;
      keys.add(key);
    }
  }
  return null;
}

// The first error in `text` as `line:column: invalid JSON, <what was expected>`, or null if jsonc-parser finds none.
// V8's own message names no position for an early end or a trailing comma, and quotes the Layer's text, line breaks
// and all. jsonc-parser only locates the error: it never throws, and it sets a prototype from a "__proto__" key, so
// JSON.parse alone decides what a Layer holds.
function jsonError(text: string): string | null {
  let found: string | null = null;
  // jsonc-parser gives an error's code, offset and length, then its line and column.
  const onError = (code: jsonc.ParseErrorCode, ...[, , line, column]: number[]) => {
    const expected = jsonc
      .printParseErrorCode(code)
      .replace(/[A-Z]/g, (letter, index) => `${index ? ' ' : ''}${letter.toLowerCase()}`);
    found ??= `${line + 1}:${column + 1}: invalid JSON, ${expected}`;
  };
  jsonc.visit(text, { onError }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
  return found;
}

function readLayer(file: string): Layer {
  const text = readFileSync(file, 'utf8');
  let layer: Layer;
  try {
    layer = JSON.parse(text);
  } catch (err) {
    const where = jsonError(text);
    throw new Error(where ? `${file}:${where}` : `${file}: ${(err as Error).message}`);
  }
  const key = duplicateKey(text);
  if (key !== null) throw new Error(`${file}: key "${key}" appears twice in one object`);
  return layer;
}

// A repository's unsandboxed commands, its test paths and who decides its approvals arrive whole from its own Layer: no
// other Layer may extend or narrow them (ADR 0013, ADR 0014).
function rejectRepoOnly(layer: Layer, file: string): void {
  const key = ['commands', 'testPaths', 'approvers'].find((name) => Object.hasOwn(layer, name));
  if (key) throw new Error(`${file}: ${key} may be set only in a repository Layer`);
}

const values = (value: unknown): unknown[] => (referencePaths.isRecord(value) ? Object.values(value) : []);
const field = (value: unknown, key: string): unknown => (referencePaths.isRecord(value) ? value[key] : undefined);

// The file names a Layer's own JSON declares, at the keys that name a file: an Agent's or inline Vertex's `persona`, an
// Action's `brief`, `schema`, `body` and `recoverBrief`, a Procedure's `recover.brief` and a Claim token's `comment`.
function declaredFiles(layer: Layer): string[] {
  const names: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && value) names.push(value);
  };
  for (const agent of values(layer.agents)) add(field(agent, 'persona'));
  for (const flow of values(layer.flows))
    for (const vertex of values(field(field(flow, 'ticket'), 'vertices'))) add(field(vertex, 'persona'));
  for (const procedure of values(layer.procedures)) {
    const actions = field(procedure, 'actions');
    for (const action of Array.isArray(actions) ? actions : [])
      for (const key of ['brief', 'schema', 'body', 'recoverBrief']) add(field(action, key));
    add(field(field(procedure, 'recover'), 'brief'));
    for (const token of values(field(procedure, 'claimTokens'))) add(field(token, 'comment'));
  }
  return names;
}

// Each file `layer` (read from `file`) declares, read beside `file` into `files` as { bytes, hash }. The Layer whose
// own JSON holds a name owns its file, so a later Layer that only sets an Agent's harness does not move its Persona.
// `from` records each name's path and Layer file: one name naming two files is a load error.
function loadFiles(layer: Layer, file: string, files: LayerFiles, from: FileSources): void {
  for (const name of declaredFiles(layer)) {
    const path = resolve(dirname(file), name);
    if (Object.hasOwn(from, name)) {
      if (from[name].path !== path)
        throw new Error(
          `file ${JSON.stringify(name)} is declared by ${from[name].file} and by ${file}, each beside its own ` +
            'Layer; give one of them another name',
        );
      continue;
    }
    let bytes;
    try {
      bytes = readFileSync(path, 'utf8');
    } catch (err) {
      const { code, message } = err as NodeJS.ErrnoException;
      throw new Error(`${file} names file ${JSON.stringify(name)}, which cannot be read (${code ?? message})`);
    }
    from[name] = { path, file };
    files[name] = { bytes, hash: sha256(bytes) };
  }
}

function readDefaults(files: LayerFiles, from: FileSources): Layer {
  const file = join(DEFAULTS_DIRECTORY, 'gg.json');
  const config = readLayer(file);
  rejectRepoOnly(config, file);
  loadFiles(config, file, files, from);
  return config;
}

// The shipped Layer: defaults/gg.json plus the bytes and hash of every file it names (`files`).
export function loadDefaults(): Config {
  const files: LayerFiles = {};
  return { ...readDefaults(files, {}), files } as Config;
}

// Objects merge key by key at every depth; anything else in the later Layer replaces the earlier value.
const merge = (base: unknown, layer: unknown): unknown =>
  referencePaths.isRecord(base) && referencePaths.isRecord(layer)
    ? Object.fromEntries(
        [...new Set([...Object.keys(base), ...Object.keys(layer)])].map((key) => [
          key,
          Object.hasOwn(layer, key) ? merge(base[key], layer[key]) : base[key],
        ]),
      )
    : layer;
// P2: a Flow or Procedure arrives whole, so a later Layer's replaces the earlier one of its name rather than merging
// into it. Until #121 the defaults declare both, and a repository Layer's own would otherwise gain the defaults' Claim
// tokens.
const WHOLE = ['flows', 'procedures'];
const mergeLayer = (base: Layer, layer: Layer): Layer => ({
  ...(merge(base, layer) as Layer),
  ...Object.fromEntries(
    WHOLE.filter((key) => referencePaths.isRecord(base[key]) && referencePaths.isRecord(layer[key])).map((key) => [
      key,
      { ...(base[key] as Layer), ...(layer[key] as Layer) },
    ]),
  ),
});

// defaults < user < repo, with the files each Layer names. `files` is gg's own: no Layer sets it.
// shortcut: a plain deep merge; slice 5 brings the migration table.
export function loadLayers(repoRoot: string, home = homedir()): Config {
  const files: LayerFiles = {};
  const from: FileSources = {};
  let config = readDefaults(files, from);
  for (const directory of [home, repoRoot]) {
    const path = layerPath(directory);
    if (!existsSync(path)) continue;
    const layer = readLayer(path);
    if (directory === home) rejectRepoOnly(layer, path);
    loadFiles(layer, path, files, from);
    config = mergeLayer(config, layer);
  }
  return { ...config, files } as Config;
}

// A file a Layer named, by that name (loadLayers's `files`).
export function layerFile(files: unknown, name: unknown): string {
  if (!referencePaths.isRecord(files) || !Object.hasOwn(files, name as string))
    throw new Error(`no Layer names file ${JSON.stringify(name)}`);
  return (files as LayerFiles)[name as string].bytes;
}

// Sorted keys at every depth, so the hash ignores key order.
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonical(object[key])]),
  );
}

export const hashOf = (value: unknown): string => sha256(JSON.stringify(canonical(value)));

// What a Pinned Configuration holds.
export interface PinnedConfiguration {
  flow: unknown;
  files: unknown;
  harnesses: unknown;
  launchProfile?: unknown;
  commands: unknown;
  testPaths: unknown;
  approvers?: unknown;
}

// The Pinned Configuration's hash: the Resolved Flow and every Layer file by name, never by path (no install path
// enters it).
export function configHash({
  flow,
  files,
  harnesses,
  launchProfile = null,
  commands,
  testPaths,
  approvers,
}: PinnedConfiguration): string {
  return hashOf({ flow, files, harnesses, launchProfile, commands, testPaths, approvers });
}

// Only globs that git's pathspecs (rollback) and checks.testPathMatcher (Test Immutability) read alike, and that git
// accepts inside the repository: git's `?` takes one byte of a UTF-8 name, and its brackets and backslash are syntax.
const badGlob = (glob: unknown): boolean =>
  typeof glob !== 'string' ||
  !glob.trim() ||
  /[[\]?\\:\x00-\x1f]/.test(glob) ||
  glob
    .split('/')
    .some((segment) => !segment || segment === '.' || segment === '..' || (segment.includes('**') && segment !== '**'));

// The repository Layer's testPaths as Problems, each sentence naming `file`; none for a non-empty list of globs.
export function testPathsProblems(testPaths: unknown, file: string): report.Problem[] {
  const found = report.newReport();
  if (testPaths === undefined) {
    const message = `${file} declares no testPaths; merge {"testPaths":["<glob>"]} into it`;
    report.error(found, 'testPaths', 'required-key-missing', message, { key: 'testPaths', file });
  } else if (!Array.isArray(testPaths) || !testPaths.length) {
    const code = Array.isArray(testPaths) ? 'empty-list' : 'not-a-list';
    report.error(found, 'testPaths', code, `${file}: testPaths must be a non-empty list of glob strings`, { file });
  } else {
    testPaths.forEach((glob, index) => {
      if (!badGlob(glob)) return;
      const message =
        `${file}: testPaths entry ${JSON.stringify(glob)} must be a glob relative to the repository root: ` +
        'non-empty segments split by "/", no "." or ".." segment, "**" only as a whole segment, ' +
        'and no [ ] ? \\ : or control character';
      report.error(found, `testPaths[${index}]`, 'invalid-glob', message, { glob, file });
    });
  }
  return found.errors;
}

// The repository Layer's approvers as Problems, naming `file`; none for no list or a list of logins.
export function approversProblems(approvers: unknown, file: string): report.Problem[] {
  const found = report.newReport();
  if (approvers === undefined) return found.errors;
  // A login with space around it never matches the actor GitHub names.
  const logins = Array.isArray(approvers) ? approvers : null;
  const valid = logins?.every((login) => typeof login === 'string' && login.trim() && login === login.trim());
  const message = `${file}: approvers must be a list of GitHub logins, each non-empty with no surrounding space`;
  if (!valid) report.error(found, 'approvers', logins ? 'invalid-name' : 'not-a-list', message, { file });
  return found.errors;
}

// The repository Layer's Declared Commands as Problems, each sentence naming `file`; none for a valid set with a test.
export function commandProblems(declared: unknown, file: string): report.Problem[] {
  const found = report.newReport();
  const commands = declared === undefined ? {} : declared;
  if (!referencePaths.isRecord(commands)) {
    report.error(found, 'commands', 'not-an-object', `${file}: commands must be an object from name to command line`, {
      file,
    });
    return found.errors;
  }
  for (const [name, line] of Object.entries(commands)) {
    // A name that breaks the rule may hold any character, so it is located at commands, not in a path of its own.
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      const message = `${file}: command name "${name}" must match [a-z][a-z0-9-]*`;
      report.error(found, 'commands', 'invalid-name', message, { name, file });
    } else if (typeof line !== 'string' || !line.trim() || /[\r\n]/.test(line)) {
      const message = `${file}: command ${name} must be a non-empty single-line string`;
      report.error(found, `commands.${name}`, 'invalid-command-line', message, { command: name, file });
    }
  }
  if (!Object.hasOwn(commands, 'test')) {
    const message = `${file} declares no test command; merge {"commands":{"test":"<command line>"}} into it`;
    report.error(found, 'commands', 'required-key-missing', message, { key: 'test', file });
  }
  return found.errors;
}

// What gg run preflight and gg doctor both check of the keys only the repository Layer at `file` declares.
export const repositoryLayerProblems = (
  layer: { commands?: unknown; testPaths?: unknown; approvers?: unknown },
  file: string,
): report.Problem[] => [
  ...commandProblems(layer.commands, file),
  ...testPathsProblems(layer.testPaths, file),
  ...approversProblems(layer.approvers, file),
];
