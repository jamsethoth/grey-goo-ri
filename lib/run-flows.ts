// The Flows a Run admits: each source's Flows as the validator resolves them, each with its Pinned Configuration, the
// one `--flow` names, preflight over every admitted Flow's Harnesses, and the Flow an Execution runs.
import { existsSync } from 'node:fs';
import * as config from './config.ts';
import * as contract from './harnesses/contract.ts';
import * as model from './model.ts';
import * as report from './validate/report.ts';
import * as settingsModule from './settings.ts';
import * as stateDatabase from './state-database.ts';
import * as validator from './validate/index.ts';

// A user Flow's name carries its source, so no Flow shadows another (ADR 0022).
const USER_PREFIX = 'user:';
const SOURCE_NAMES = { repository: 'the repository', user: "the user's directory" };
export type SourceName = keyof typeof SOURCE_NAMES;
export const sourceText = (source: SourceName): string => SOURCE_NAMES[source];

// One declared Flow by its qualified name: its Resolved Flow (as the validator gives it, named so), the name its
// source declares it under, its source, and the files that source names.
export interface DeclaredFlow {
  json: Record<string, unknown>;
  declaredName: string;
  source: SourceName;
  files: config.SourceFiles;
}

// A declared Flow, its Pinned Configuration (the Flow with the files, Harnesses and commands it runs under), that
// configuration's Config Hash, its source and the files it uses.
export interface PinnedFlow {
  flow: model.ResolvedFlow;
  pinned: unknown;
  hash: string;
  source: SourceName;
  files: config.SourceFiles;
}

const withExitCode = (message: string, exitCode: number) => Object.assign(new Error(message), { exitCode });

// One source through the validator, against the repository's commands and labelPrefix, its schemas and templates read
// from its own files.
function validateSource(source: config.Source, harnesses: unknown, repository: config.Source) {
  return validator.validate(source, {
    harnesses,
    readSchema: (name) => JSON.parse(config.namedFile(source.files, name)),
    readTemplate: (name) => config.namedFile(source.files, name),
    contract: { commands: repository.commands, labelPrefix: repository.labelPrefix },
  });
}

const declaresFlows = (source: config.Source) =>
  ['flows', 'procedures', 'agents'].some((key) => Object.hasOwn(source, key));

// The commands a Resolved Flow's Procedures name that the repository does not declare.
function undeclaredCommands(json: Record<string, unknown>, commands: unknown): string[] {
  const procedures = Object.values((json.procedures ?? {}) as Record<string, { actions?: { command?: unknown }[] }>);
  const named = procedures.flatMap(({ actions = [] }) => actions.map((action) => action?.command));
  return [
    ...new Set(named.filter((name): name is string => typeof name === 'string' && !report.hasOwnKey(commands, name))),
  ];
}

// The user's Flows, which serve every repository: one that names a command this repository does not declare does not
// fit it, a warning in gg doctor and an error only when selected (Q21), so the validator's own undeclared-command
// errors give way to that.
function userFlows(configuration: config.Configuration, harnesses: unknown) {
  const { user, repository, repositoryFile } = configuration;
  const flows = new Map<string, DeclaredFlow>();
  const misfits = new Map<string, report.Problem>();
  if (!declaresFlows(user)) return { flows, errors: [], warnings: [], misfits };
  const validated = validateSource(user, harnesses, repository);
  // A Problem's location names the user's source, as its Flows' names do.
  // eslint-disable-next-line id-denylist -- a Problem's location is at
  const located = (problem: report.Problem) => ({ ...problem, at: `${USER_PREFIX}${problem.at || 'gg.json'}` });
  // Only a command named by a string fits one repository and not another; a malformed one is an error anywhere.
  const fits = (problem: report.Problem) =>
    problem.code !== 'no-flow-declared' &&
    !(problem.code === 'undeclared-command' && typeof problem.params?.command === 'string');
  for (const [declaredName, json] of Object.entries(validated.flows)) {
    if (json === undefined) continue;
    const name = `${USER_PREFIX}${declaredName}`;
    flows.set(name, { json: { ...json, name }, declaredName, source: 'user', files: user.files });
    const [command] = undeclaredCommands(json, repository.commands);
    if (command === undefined) continue;
    const found = report.newReport();
    const message =
      `Flow ${name} names command ${JSON.stringify(command)}, which ${repositoryFile} does not declare, so it cannot ` +
      'run in this repository';
    report.warn(found, `${USER_PREFIX}flows.${declaredName}`, 'undeclared-command', message, { command });
    misfits.set(name, found.warnings[0]!);
  }
  return {
    flows,
    errors: validated.errors.filter(fits).map(located),
    warnings: validated.warnings.map(located),
    misfits,
  };
}

// Every declared Flow of both sources by its qualified name, the Problems of both gg.json files and of their Flows,
// and each user Flow that does not fit the repository. gg doctor and gg run admission share it (V1).
export function declaredFlows(configuration: config.Configuration, harnesses: unknown) {
  const { repository } = configuration;
  const validated = validateSource(repository, harnesses, repository);
  const user = userFlows(configuration, harnesses);
  // With a user Flow to run, a repository that declares none still has its contract to run it under.
  const repositoryErrors = validated.errors.filter(
    (problem) => problem.code !== 'no-flow-declared' || !user.flows.size,
  );
  const flows = new Map<string, DeclaredFlow>();
  for (const [name, json] of Object.entries(validated.flows))
    if (json !== undefined)
      flows.set(name, { json, declaredName: name, source: 'repository', files: repository.files });
  for (const [name, flow] of user.flows) flows.set(name, flow);
  return {
    flows,
    errors: [...settingsModule.sourceProblems(configuration), ...repositoryErrors, ...user.errors],
    warnings: [...validated.warnings, ...user.warnings],
    misfits: user.misfits,
  };
}

// What a resumed Execution whose Flow is gone says, in the Run's log and in gg doctor (A2).
export const missingFlowAdvice = (flow: string, ticket: number): string =>
  `runs Flow ${flow}, which is no longer declared; declare it again to resume it, or run gg work abandon ${ticket} ` +
  'to start over';

// A resumed Execution runs the Flow its record pins (X2). One no longer declared is kept until it is again, or a person
// abandons it, and the Run says so loudly and exits 2 (A2); null when its Flow is admitted.
export function missingFlow(
  { flows, log }: { flows: ReadonlyMap<string, PinnedFlow>; log: (line: string) => void },
  { ticket, flow }: { ticket: number; flow: string },
) {
  if (flows.has(flow)) return null;
  log(`#${ticket} ERROR its Execution Record ${missingFlowAdvice(flow, ticket)}`);
  return { ticket, outcome: 'skipped', flowMissing: true };
}

// A Harness module as preflight checks it: the shipped modules declare only their paths until slices 2 and 3.
interface PreflightHarness {
  run?: unknown;
  validate(agent: unknown): Promise<{ ok: boolean; errors: string[] }>;
  resolveTools(agent: unknown): Promise<unknown>;
}

// Each Vertex's registered Harness, checked by name before any GitHub access.
async function harnessProblems(failed: report.Report, flow: model.ResolvedFlow, harnesses: Record<string, unknown>) {
  for (const [id, { agent }] of flow.ticket.vertices) {
    const harness =
      agent && typeof agent.harness === 'string' && Object.hasOwn(harnesses, agent.harness)
        ? (harnesses[agent.harness] as PreflightHarness)
        : null;
    // A Vertex without an Agent (publish) runs on no Harness; an unset or unregistered one is the validator's error.
    if (!harness) continue;
    try {
      // shortcut: the shipped Harness modules declare only their paths until slices 2 and 3; drop this when each
      // implements the contract.
      if (!harness.run) throw new Error('not implemented');
      contract.assertHarness(harness);
      const { ok, errors } = await harness.validate(agent);
      if (!ok) throw new Error(errors.join(', '));
      await harness.resolveTools(agent);
    } catch (err) {
      const reason = (err as Error).message.split('\n')[0];
      const harnessName = agent!.harness as string;
      const location = `flows.${flow.name}.ticket.vertices.${id}`;
      const message = `vertex ${id}: harness ${harnessName}: ${reason}`;
      report.error(failed, location, 'harness-preflight-failed', message, { vertex: id, harness: harnessName, reason });
    }
  }
}

// The configuration's errors, as gg doctor prints them (V1), and the registered Harness of every Vertex of every
// admitted Flow, since a resumed Execution runs the Flow its record pins, all failures in one error. An unset Harness
// is a configuration gap, so any one makes the error exit 2.
async function preflight(flows: model.ResolvedFlow[], errors: report.Problem[], harnesses: Record<string, unknown>) {
  const unset = errors.some((error) => error.code === 'harness-unset');
  const failedHarnesses = report.newReport();
  for (const flow of flows) await harnessProblems(failedHarnesses, flow, harnesses);
  const failed = [...errors, ...failedHarnesses.errors].map((problem) => report.line('error', problem));
  if (unset)
    failed.push(
      "Set each Agent's harness, model and effort in the gg.json that declares it; gg init --harness " +
        `${config.exampleHarnesses().join(' or ')} writes them into the example, from ${config.EXAMPLES_DIRECTORY}.`,
    );
  if (failed.length) throw withExitCode(`preflight failed:\n${failed.join('\n')}`, unset ? 2 : 1);
}

// What gg run admits: both sources, the registered Harnesses, the Flow `--flow` names, and the repository's common
// dir, which must hold the State Database.
interface Admitted {
  commonDir: string;
  config: config.Configuration;
  harnesses: Record<string, unknown>;
  flow?: string;
}

// The Flow at `name` pinned with the files it uses from its own source and the repository contract. The source stays
// out of the hash, and so does the prefix that names it, so a Flow hashes alike from either source (Q25).
function pin(name: string, declared: DeclaredFlow, settings: config.Settings): PinnedFlow {
  const files = config.usedFiles(declared.json, declared.files);
  const pinned = {
    flow: { ...declared.json, name: declared.declaredName },
    files,
    harnesses: {},
    launchProfile: null,
    commands: settings.commands,
    testPaths: settings.testPaths,
    approvers: settings.approvers,
  };
  const flow = model.fromJson({ ...declared.json, name });
  return { flow, pinned, hash: config.configHash(pinned), source: declared.source, files };
}

// A repository without a State Database, as an error: only gg init creates one (#150), so gg run's preflight and
// gg doctor both name it.
export function stateDatabaseProblems(commonDir: string): report.Problem[] {
  if (existsSync(stateDatabase.filePath(commonDir))) return [];
  const found = report.newReport();
  const path = stateDatabase.filePath(commonDir);
  report.error(found, '', 'state-database-missing', stateDatabase.missingMessage(commonDir), { path });
  return found.errors;
}

// Admission runs the checks gg doctor runs, so gg run rejects exactly what gg doctor rejects (V1, ADR 0014), except a
// user Flow that does not fit the repository, refused only when selected. A new Execution runs the Flow `--flow` names,
// else default (X2), which must be declared.
export async function admitConfiguration({
  commonDir,
  config: configuration,
  harnesses,
  flow: flowName = 'default',
}: Admitted) {
  const declared = declaredFlows(configuration, harnesses);
  const { errors, warnings, misfits } = declared;
  const misfit = misfits.get(flowName);
  if (misfit) errors.push(misfit);
  const names = [...declared.flows.keys()];
  if (names.length && !declared.flows.has(flowName)) {
    const unknown = report.newReport();
    const message = `no Flow named ${flowName} is declared; the declared Flows are ${names.join(', ')}`;
    report.error(unknown, 'flows', 'unknown-flow', message, { name: flowName, declared: names });
    errors.push(...unknown.errors);
  }
  errors.push(...stateDatabaseProblems(commonDir));
  const admitted = [...declared.flows].filter(([name]) => !misfits.has(name));
  await preflight(
    admitted.map(([name, { json }]) => model.fromJson({ ...json, name })),
    errors,
    harnesses,
  );
  // The settings are read only once preflight has found none of their Problems.
  const settings = settingsModule.runSettings(configuration);
  const flows = new Map(admitted.map(([name, flow]) => [name, pin(name, flow, settings)]));
  return { flows, selected: flows.get(flowName)!, warnings, settings };
}

// The Flow an Execution runs: the one its record pins, whatever `--flow` says (X2). Admission runs a record whose Flow
// is no longer declared only to finish a decided report, which runs no Vertex, so it runs under an empty Flow of that
// name, no files and the Config Hash the caller gives, the record's own.
export function pinnedFlow(flows: ReadonlyMap<string, PinnedFlow>, name: string, hash: string): PinnedFlow {
  const ticket = { entry: null, vertices: new Map<string, model.Vertex>() };
  const empty = { name, actionCap: 0, procedures: new Map(), ticket };
  return flows.get(name) ?? { flow: empty, pinned: null, hash, source: 'repository', files: {} };
}
