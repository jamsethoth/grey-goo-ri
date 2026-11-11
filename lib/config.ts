import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsonc from 'jsonc-parser';
import * as jsonValue from './json-value.ts';
import type * as model from './model.ts';
import * as referencePaths from './reference-paths.ts';
import * as report from './validate/report.ts';

// Each Harness's settings for the example's Agents, which gg init --harness writes.
export const EXAMPLES_DIRECTORY = fileURLToPath(new URL('../examples/', import.meta.url));
// The Harnesses gg init --harness takes: one for each file in examples/.
export const exampleHarnesses = (): string[] =>
  readdirSync(EXAMPLES_DIRECTORY)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort();

// Each file a source's gg.json names, by that name: its text and the hash the Config Hash takes of it.
export type SourceFiles = Record<string, { bytes: string; hash: string }>;
// One source's gg.json as read, and the files it names, read beside it.
export interface Source {
  files: SourceFiles;
  [key: string]: unknown;
}
// The two sources gg reads, the repository's .agents/gg/ and the user's GG_HOME, and where each gg.json is. Nothing
// merges between them (ADR 0022).
export interface Configuration {
  repository: Source;
  user: Source;
  repositoryFile: string;
  userFile: string;
}
// The settings a Run reads, from the repository contract and the user's machine settings, once both are checked.
export interface Settings {
  labelPrefix: string;
  baseBranch: string;
  worktreeRoot: string;
  maxParallel: number;
  commands: Record<string, jsonValue.JsonValue>;
  testPaths: string[];
  approvers?: string[];
}

export const repositoryDirectory = (repoRoot: string): string => join(repoRoot, '.agents', 'gg');
// One variable moves a person's whole setup, as the agent CLIs' own home variables do (Q19).
export const userDirectory = (environment: NodeJS.ProcessEnv = process.env, home = homedir()): string =>
  environment.GG_HOME || join(home, '.agents', 'gg');
export const configFile = (directory: string): string => join(directory, 'gg.json');

// The one hash gg takes of bytes or text: file hashes, the Config Hash, body hashes and digests.
export const sha256 = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

// JSON.parse keeps the last of two equal keys, so a gg.json is scanned for them once it parses (ADR 0013).
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
// V8's own message names no position for an early end or a trailing comma, and quotes the gg.json's text, line breaks
// and all. jsonc-parser only locates the error: it never throws, and it sets a prototype from a "__proto__" key, so
// JSON.parse alone decides what a gg.json holds.
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

// Syntax errors and duplicate keys are load errors, since nothing can be read past them (D7).
function readConfigFile(file: string): Record<string, unknown> {
  const text = readFileSync(file, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    const where = jsonError(text);
    throw new Error(where ? `${file}:${where}` : `${file}: ${(err as Error).message}`);
  }
  const key = duplicateKey(text);
  if (key !== null) throw new Error(`${file}: key "${key}" appears twice in one object`);
  if (!referencePaths.isRecord(json)) throw new Error(`${file}: a gg.json must be a JSON object`);
  return json;
}

const values = (value: unknown): unknown[] => (referencePaths.isRecord(value) ? Object.values(value) : []);
const field = (value: unknown, key: string): unknown => (referencePaths.isRecord(value) ? value[key] : undefined);

// The file names a Procedure declares: an Action's `brief`, `schema`, `body` and `recoverBrief`, its `recover.brief`
// and a Claim token's `comment`.
function procedureFiles(procedure: unknown, add: (name: unknown) => void) {
  const actions = field(procedure, 'actions');
  for (const action of Array.isArray(actions) ? actions : [])
    for (const key of ['brief', 'schema', 'body', 'recoverBrief']) add(field(action, key));
  add(field(field(procedure, 'recover'), 'brief'));
  for (const token of values(field(procedure, 'claimTokens'))) add(field(token, 'comment'));
}

// The names `collect` finds, each once.
function namesOf(collect: (add: (name: unknown) => void) => void): string[] {
  const names = new Set<string>();
  collect((value) => {
    if (typeof value === 'string' && value) names.add(value);
  });
  return [...names];
}

// The file names a gg.json declares: an Agent's or inline Vertex's `persona`, and each Procedure's files.
const declaredFiles = (json: Record<string, unknown>): string[] =>
  namesOf((add) => {
    for (const agent of values(json.agents)) add(field(agent, 'persona'));
    for (const flow of values(json.flows))
      for (const vertex of values(field(field(flow, 'ticket'), 'vertices'))) add(field(vertex, 'persona'));
    for (const procedure of values(json.procedures)) procedureFiles(procedure, add);
  });

// The files a Resolved Flow uses: each Vertex's Persona and each Procedure's files. Only these enter its Pinned
// Configuration, so a file another Flow or Agent of the same source names never moves its Config Hash (Q25).
export function usedFiles(flow: unknown, files: SourceFiles): SourceFiles {
  const names = namesOf((add) => {
    for (const vertex of values(field(field(flow, 'ticket'), 'vertices')))
      add(field(field(vertex, 'agent'), 'persona'));
    for (const procedure of values(field(flow, 'procedures'))) procedureFiles(procedure, add);
  });
  return Object.fromEntries(names.filter((name) => Object.hasOwn(files, name)).map((name) => [name, files[name]!]));
}

// A source's gg.json and each file it names, read beside it; a source with no gg.json is empty, and its required
// settings are Problems, not a load error.
function readSource(file: string): Source {
  if (!existsSync(file)) return { files: {} };
  const json = readConfigFile(file);
  // Built from entries, so a file such as __proto__ loads like any other (#174).
  const files = declaredFiles(json).map((name) => {
    let bytes;
    try {
      bytes = readFileSync(resolve(dirname(file), name), 'utf8');
    } catch (err) {
      const { code, message } = err as NodeJS.ErrnoException;
      throw new Error(`${file} names file ${JSON.stringify(name)}, which cannot be read (${code ?? message})`);
    }
    return [name, { bytes, hash: sha256(bytes) }];
  });
  return { ...json, files: Object.fromEntries(files) };
}

// The repository's .agents/gg/ and the user's directory, each whole: nothing merges (ADR 0022).
export function loadSources(repoRoot: string, directory = userDirectory()): Configuration {
  const repositoryFile = configFile(repositoryDirectory(repoRoot));
  const userFile = configFile(directory);
  return { repository: readSource(repositoryFile), user: readSource(userFile), repositoryFile, userFile };
}

// A file a source named, by that name (loadSources's `files`).
export function namedFile(files: unknown, name: unknown): string {
  if (!referencePaths.isRecord(files) || !Object.hasOwn(files, name as string))
    throw new Error(`no source names file ${JSON.stringify(name)}`);
  return (files as SourceFiles)[name as string]!.bytes;
}

// Sorted keys at every depth, so the hash ignores key order.
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (!value || typeof value !== 'object') return value;
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, sortedKeys(object[key])]),
  );
}

// A Map has no keys to sort and would hash as {} in silence, so the hash takes only what a save takes: the model's
// toJson gives the JSON to hash (#174).
export function hashOf(value: unknown): string {
  return sha256(JSON.stringify(sortedKeys(jsonValue.checked(value, 'the value to hash'))));
}

// What a Pinned Configuration holds.
export interface PinnedConfiguration {
  flow: model.ResolvedFlowJson;
  files: SourceFiles;
  harnesses: Record<string, jsonValue.JsonValue>;
  launchProfile?: string | null;
  commands: Settings['commands'];
  testPaths: string[];
  approvers?: string[];
}

// The Pinned Configuration's hash: the Resolved Flow and every file it uses by name, never by path (no install path
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
