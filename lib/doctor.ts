// `gg doctor`: each source's Resolved Flows, warnings and errors, printed per Vertex (V1). `gg init`: the example
// written into a repository, and the user's machine settings.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as jsonc from 'jsonc-parser';
import * as config from './config.ts';
import * as configurationCheck from './configuration-check.ts';
import type * as github from './github.ts';
import * as labels from './labels.ts';
import * as referencePaths from './reference-paths.ts';
import * as rules from './rules.ts';
import * as stateDatabase from './state-database.ts';
import type * as graph from './validate/graph.ts';
import * as report from './validate/report.ts';

type Value = Record<string, unknown>;
// A Procedure as the Resolved Flow carries it, as written; doctor prints what each field holds.
interface ShownProcedure {
  access?: unknown;
  actions?: (Value | null)[];
  claimTokens: Record<string, { stop?: unknown; requires?: unknown[] } | null>;
  passed: unknown[];
  failed: unknown[];
  stopped: unknown[];
  otherwise: unknown;
}
// A route's target: a Vertex id, an end, or an Edge with its Bound.
interface Target {
  end?: unknown;
  to?: unknown;
  max?: unknown;
  exhausted?: unknown;
}

const { shown } = report;

function target(given: unknown): string {
  if (typeof given === 'string') return given;
  const edge = given as Target | null | undefined;
  if (edge?.end !== undefined) return `end ${shown(edge.end)}`;
  const exhausted = edge?.exhausted === undefined ? '' : `, exhausted ${target(edge.exhausted)}`;
  return `${shown(edge?.to ?? 'no target')} (max ${shown(edge?.max ?? 'none')}${exhausted})`;
}
const list = (items: unknown[]) => (items.length ? items.map(shown).join(', ') : 'none');
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function table(name: string, rows: unknown[]): string[] {
  if (!rows.length) return [`  ${name}: none`];
  return [
    `  ${name}:`,
    ...rows.map((row, index) => {
      const { when, outcome } = (row ?? {}) as { when?: Record<string, rules.Condition>; outcome?: unknown };
      return `    ${index + 1}. ${rules.conditions(when ?? {})} -> ${shown(outcome ?? 'no outcome')}`;
    }),
  ];
}

// Why a Vertex has its access: its Procedure's read-only caps it, or its Agent names none.
function accessNote(vertex: graph.ResolvedVertex, procedure: ShownProcedure | undefined): string {
  if (procedure?.access === 'read-only') return ' (capped by the Procedure)';
  return vertex.agent?.access == null ? ' (default)' : '';
}

function testsLine(tests: unknown): string {
  if (typeof tests === 'object' && tests !== null)
    return `named ${shown((tests as { named: unknown }).named ?? 'nothing')}`;
  return shown(tests ?? 'none');
}

function procedureLines(procedure: ShownProcedure): string[] {
  const checks = (procedure.actions ?? []).filter((action) => action?.do === 'check') as Value[];
  const claimTokens = Object.entries(procedure.claimTokens).map(([token, claim]) =>
    claim?.stop ? `${token} stops` : `${token} requires ${list((claim?.requires ?? []).map((id) => id ?? 'no id'))}`,
  );
  const shownChecks = checks.map((check) => {
    const command = check.command ? ` ${shown(check.command)}` : '';
    return `${shown(check.id ?? 'no id')} (${shown(check.kind ?? 'no kind')}${command})`;
  });
  const lines = [
    `  checks: ${list(shownChecks)}`,
    `  claimTokens: ${list(claimTokens)}`,
    ...table('passed', procedure.passed),
    ...table('failed', procedure.failed),
    ...table('stopped', procedure.stopped),
  ];
  if (procedure.otherwise !== null) lines.push(`  otherwise: ${shown(procedure.otherwise)}`);
  return lines;
}

// R12d, U5: which route each Outcome takes, unless the Vertex names it, and where a failure's work goes.
function routeLines(vertex: graph.ResolvedVertex): string[] {
  const routings = new Map(Object.entries(vertex.routing));
  return [
    `  routes:${vertex.outcomes.length ? '' : ' none'}`,
    ...vertex.outcomes.map((outcome) => {
      const routing = routings.get(outcome);
      if (!routing) return `    ${outcome} -> unrouted`;
      const by = routing.by === 'Vertex route' ? '' : ` (${routing.by})`;
      return `    ${outcome} -> ${target(routing.target)}${by}${routing.work ? `; work ${routing.work}` : ''}`;
    }),
  ];
}

function inputLines(vertex: graph.ResolvedVertex): string[] {
  const inputs = Object.entries(vertex.inputs);
  if (!inputs.length) return ['  inputs: none'];
  return [
    '  inputs:',
    ...inputs.map(([name, input]) => {
      const pick = input.pick === undefined ? '' : `, pick ${shown(input.pick)}`;
      const from = input.from.map((source) => shown(source ?? 'no source'));
      return `    ${name} <- ${from.join(' | ') || 'no source'}${pick}${input.optional ? ' (optional)' : ''}`;
    }),
  ];
}

function vertexLines(id: string, vertex: graph.ResolvedVertex, procedure: ShownProcedure | undefined): string[] {
  const agent = vertex.agent
    ? `${shown(vertex.use ?? 'inline')} (harness ${shown(vertex.agent.harness ?? 'none')})`
    : 'none';
  const lines = [
    `vertex ${id}`,
    `  procedure: ${shown(vertex.procedure ?? 'none')}`,
    `  agent: ${agent}`,
    `  access: ${shown(vertex.access)}${accessNote(vertex, procedure)}`,
    `  tests: ${testsLine(vertex.tests)}`,
  ];
  if (procedure) lines.push(...procedureLines(procedure));
  lines.push(`  outcomes: ${list(vertex.outcomes)}`);
  if (vertex.approvalLabels)
    lines.push(`  approval labels: ${[vertex.approvalLabels.await, ...vertex.approvalLabels.decide].join(', ')}`);
  // H11: a Vertex's bound, beside its routes.
  if (vertex.max !== null)
    lines.push(
      `  max: ${shown(vertex.max)}, exhausted ${vertex.exhausted === null ? 'none' : target(vertex.exhausted)}`,
    );
  return [...lines, ...routeLines(vertex), ...inputLines(vertex)];
}

// A Resolved Flow as doctor prints it.
interface ShownFlow {
  name: string;
  actionCap: unknown;
  procedures: Record<string, ShownProcedure>;
  ticket: { entry: unknown; routes: Record<string, unknown>; vertices: Record<string, graph.ResolvedVertex> };
}

function flowLines(flow: ShownFlow, source: configurationCheck.SourceName): string[] {
  const routes = Object.entries(flow.ticket.routes).map(([outcome, route]) => `${outcome} -> ${target(route)}`);
  const lines = [
    `flow ${flow.name}`,
    `  source: ${source}`,
    `  actionCap: ${shown(flow.actionCap ?? 'none')}`,
    `  entry: ${shown(flow.ticket.entry ?? 'none')}`,
    `  routes: ${list(routes)}`,
  ];
  const procedures = new Map(Object.entries(flow.procedures));
  for (const [id, vertex] of Object.entries(flow.ticket.vertices))
    lines.push('', ...vertexLines(id, vertex, procedures.get(vertex.procedure as string)));
  return [...lines, ''];
}

// The labels the Flows can request that the repository lacks (request 3.3), each a warning: gg run creates them before
// its first request. Nothing is read for Flows that ask nobody, and doctor's other findings stand when GitHub cannot
// say.
async function labelWarnings(
  flows: ShownFlow[],
  { gh, cwd }: Pick<DoctorOptions, 'gh' | 'cwd'>,
): Promise<report.Problem[]> {
  const asking = flows.flatMap((flow) =>
    Object.entries(flow.ticket.vertices)
      .filter(([, vertex]) => vertex.approvalLabels)
      .map(([id, vertex]) => ({ flow: flow.name, id, vertex })),
  );
  if (!asking.length) return [];
  const found = report.newReport();
  let existing: string[];
  try {
    existing = await gh.repositoryLabels(cwd);
  } catch (err) {
    const reason = gh.errorExcerpt(err as Error);
    report.warn(found, '', 'repository-labels-unread', `could not read the repository's labels: ${reason}`, { reason });
    return found.warnings;
  }
  for (const { flow, id, vertex } of asking) {
    const { await: awaitLabel, decide } = vertex.approvalLabels!;
    const missing = [awaitLabel, ...decide].filter((label) => !labels.hasLabel(existing, label));
    const message = `labels missing from the repository: ${missing.join(', ')}`;
    const location = `flows.${flow}.ticket.vertices.${id}`;
    if (missing.length) report.warn(found, location, 'repository-labels-missing', message, { labels: missing });
  }
  return found.warnings;
}

// What gg doctor reads: both sources and the registered Harnesses, GitHub for the labels a Flow can request, and the
// repository's common dir for the State Database and the Execution Records whose Flow is gone.
export interface DoctorOptions {
  config: config.Configuration;
  commonDir?: string;
  harnesses: Record<string, unknown>;
  gh: github.Gh;
  cwd: string;
}

// gg doctor prints the checked configuration gg run admits by, so it never passes what gg run refuses (V1, #362):
// every error, each record gg run would keep for its Flow being gone (A2), and each misfit as a warning, since gg run
// refuses one only when selected (Q21). Schemas and templates are read from the files each source's gg.json names
// (`config.files`).
export async function doctor({ config: configuration, harnesses, gh, cwd, commonDir }: DoctorOptions): Promise<{
  text: string;
  exitCode: number;
}> {
  const checked = await configurationCheck.check({ config: configuration, harnesses, commonDir });
  const errors = [...checked.configurationErrors, ...checked.environmentErrors, ...checked.goneFlowRecords()];
  const warnings = [...checked.warnings, ...checked.misfits.values()];
  const flows = [...checked.flows.values()];
  const lines: string[] = [];
  for (const { json, source } of flows) lines.push(...flowLines(json as unknown as ShownFlow, source));
  for (const warning of warnings) lines.push(report.line('warning', warning));
  const labelProblems = await labelWarnings(
    flows.map(({ json }) => json as unknown as ShownFlow),
    { gh, cwd },
  );
  lines.push(...labelProblems.map((warning) => report.line('warning', warning)));
  for (const error of errors) lines.push(report.line('error', error));
  const warned = warnings.length + labelProblems.length;
  lines.push(`${plural(errors.length, 'error')}${warned ? `, ${plural(warned, 'warning')}` : ''}`);
  return { text: `${lines.join('\n')}\n`, exitCode: errors.length ? 1 : 0 };
}

// The example `gg init` writes is the fixture the tests run, so the two cannot drift; doctor.txt is that fixture's
// expected gg doctor output, not part of the example.
const EXAMPLE_DIRECTORY = fileURLToPath(new URL('../test/fixtures/example/', import.meta.url));
// The machine settings gg init writes into a new user gg.json.
const MACHINE_SETTINGS = { maxParallel: 2, worktreeRoot: '~/worktrees' };

// What gg init writes: the repository's default branch, the user's directory, a Harness whose harness, model and
// effort the example's Agents take, and the repository's common dir, where it creates the State Database.
export interface InitOptions {
  baseBranch: string;
  commonDir: string;
  userDirectory?: string;
  harness?: string;
}

// The example's gg.json as gg init writes it: without commands.test, which only the repository can say, on the
// repository's default branch, and with the named Harness's settings for each Agent.
function writtenExample(text: string, { baseBranch, harness }: InitOptions): string {
  const edit = (edited: string, path: jsonc.JSONPath, value: unknown) =>
    jsonc.applyEdits(edited, jsonc.modify(edited, path, value, {}));
  let written = edit(edit(text, ['commands', 'test'], undefined), ['baseBranch'], baseBranch);
  if (harness === undefined) return written;
  // A name, not a path: only a Harness examples/ holds settings for.
  const shipped = config.exampleHarnesses();
  if (!shipped.includes(harness))
    throw new Error(
      `no Harness named ${harness} has example settings; gg init --harness takes ${shipped.join(' or ')}`,
    );
  const file = join(config.EXAMPLES_DIRECTORY, `${harness}.json`);
  const example = JSON.parse(readFileSync(file, 'utf8'));
  // The examples are gg's own files, which the init tests read back: what is not an object of settings writes nothing.
  for (const [agent, settings] of report.entries(referencePaths.isRecord(example) ? example.agents : null))
    for (const [key, value] of report.entries(settings)) written = edit(written, ['agents', agent, key], value);
  return written;
}

const userAdvice = (userFile: string | null) =>
  userFile ? `gg init wrote the machine settings maxParallel and worktreeRoot to ${userFile}.\n` : '';

function initAdvice(directory: string, names: string[], userFile: string | null, database: string): string {
  return `gg init wrote the example to ${directory}: ${names.join(', ')}.
${userAdvice(userFile)}${database}
Before gg doctor passes, declare the command that runs your tests as commands.test in gg.json. Every Check in the
example runs it. Each Agent runs on the harness gg.json names; gg init --harness <name> also writes a model and
effort for each, for ${config.exampleHarnesses().join(' or ')}.

gg assumes the test command is deterministic: a test that fails on a tree it passed on ends the Ticket at needs-human.
gg pushes agent-written commits, which this repository's CI runs with its GITHUB_TOKEN, so we recommend
read-only default workflow permissions (Settings > Actions > General > Workflow permissions).
`;
}

// The user's gg.json with the machine settings, unless one exists: the user's directory serves every repository.
function writeUserSettings(directory: string): string | null {
  const file = config.configFile(directory);
  if (existsSync(file)) return null;
  mkdirSync(directory, { recursive: true });
  writeFileSync(file, `${JSON.stringify(MACHINE_SETTINGS, null, 2)}\n`, { flag: 'wx' });
  return file;
}

// The State Database, created when missing (#150). An existing one is kept and opened once, so gg init never
// reports as kept one no command can open; it leaves that one untouched, since it may hold Execution Records and is
// the evidence of what went wrong (owner, #150 Q2, ADR 0023).
function initStateDatabase(commonDir: string): string {
  const created = stateDatabase.create(commonDir);
  try {
    stateDatabase.open(commonDir);
  } catch (err) {
    const newer = err instanceof stateDatabase.StateDatabaseVersionError && err.version > stateDatabase.SCHEMA_VERSION;
    const advice = newer
      ? 'run the gg that wrote it.'
      : 'move it aside and keep it, since it may hold Execution Records and shows what went wrong, then run gg init ' +
        'again to create a new one.';
    throw new Error(`${(err as Error).message}\ngg init kept it untouched: ${advice}`, { cause: err });
  } finally {
    stateDatabase.close(commonDir);
  }
  return `gg init ${created ? 'created' : 'kept'} the State Database at ${stateDatabase.filePath(commonDir)}.\n`;
}

// Writes the example into `repoRoot`'s .agents/gg/, unless a file it would write exists: then it writes none of it, so
// gg init is safe to repeat (owner, 2026-11-06). It also creates the user's gg.json and the State Database when there
// is none.
export function init(repoRoot: string, options: InitOptions): string {
  const directory = config.repositoryDirectory(repoRoot);
  const names = [
    'gg.json',
    ...readdirSync(EXAMPLE_DIRECTORY).filter((name) => !['gg.json', 'doctor.txt'].includes(name)),
  ];
  const existing = names.map((name) => join(directory, name)).find((path) => existsSync(path));
  const example = existing ? null : writtenExample(readFileSync(join(EXAMPLE_DIRECTORY, 'gg.json'), 'utf8'), options);
  const database = initStateDatabase(options.commonDir);
  const userFile = writeUserSettings(options.userDirectory ?? config.userDirectory());
  if (existing)
    return (
      `gg init kept the existing configuration and wrote none of the example: ${existing} exists.\n` +
      userAdvice(userFile) +
      database
    );
  mkdirSync(directory, { recursive: true });
  for (const name of names) {
    const text = name === 'gg.json' ? example! : readFileSync(join(EXAMPLE_DIRECTORY, name), 'utf8');
    writeFileSync(join(directory, name), text, { flag: 'wx' });
  }
  return initAdvice(directory, names, userFile, database);
}
