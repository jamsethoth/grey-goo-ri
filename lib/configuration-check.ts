// What the configuration check finds, which gg doctor and gg run both judge by (V1): each source's Flows as the
// validator resolves them, the settings, the user Flows that do not fit the repository, the State Database, the
// Execution Records whose Flow is gone, and preflight over every admitted Flow's Harnesses. The commands differ only
// in how they present it, and in gg run's choice of Flow (#362).
import { existsSync } from 'node:fs';
import * as config from './config.ts';
import * as contract from './harnesses/contract.ts';
import * as interpreter from './interpreter.ts';
import * as model from './model.ts';
import * as record from './record.ts';
import * as settingsModule from './settings.ts';
import * as stateDatabase from './state-database.ts';
import * as report from './validate/report.ts';
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

// Every declared Flow of both sources by its qualified name, the Problems of their Flows, and each user Flow that does
// not fit the repository.
function declaredFlows(configuration: config.Configuration, harnesses: unknown) {
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
    errors: [...repositoryErrors, ...user.errors],
    warnings: [...validated.warnings, ...user.warnings],
    misfits: user.misfits,
  };
}

// What a resumed Execution whose Flow is gone says, in the Run's log and in gg doctor (A2).
export const missingFlowAdvice = (flow: string, ticket: number): string =>
  `runs Flow ${flow}, which is no longer declared; declare it again to resume it, or run gg work abandon ${ticket} ` +
  'to start over';

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

// A repository without a State Database, as an error: only gg init creates one (#150).
function stateDatabaseProblems(found: report.Report, commonDir: string) {
  const path = stateDatabase.filePath(commonDir);
  if (!existsSync(path))
    report.error(found, '', 'state-database-missing', stateDatabase.missingMessage(commonDir), { path });
}

// Each Execution Record a Run would resume whose Flow is not admitted: gg run keeps it and exits 2 for its Ticket (A2),
// and gg doctor lists every one as an error.
function goneFlowRecords(commonDir: string, admitted: ReadonlySet<string>): report.Problem[] {
  const found = report.newReport();
  for (const executionRecord of record.loadAll(commonDir, 'ticket')) {
    const { ticket, flow } = executionRecord;
    if (admitted.has(flow) || interpreter.resumption(executionRecord) !== 'resume') continue;
    const message = `Execution Record ticket-${ticket} ${missingFlowAdvice(flow, ticket)}`;
    report.error(found, `records.ticket-${ticket}`, 'unknown-flow', message, {
      name: flow,
      declared: [...admitted],
      ticket,
    });
  }
  return found.errors;
}

// What the check reads: both sources, the registered Harnesses, and the repository's common dir, which must hold the
// State Database (gg doctor may leave it out, and then checks neither it nor its records).
interface CheckOptions {
  config: config.Configuration;
  harnesses: Record<string, unknown>;
  commonDir?: string;
}

// The checked configuration: every declared Flow, the configuration's errors (the settings' first, as #301 lists
// them, then each source's), the environment's (the State Database, then the Harnesses), the records whose Flow is
// gone, the warnings, each misfit by its Flow's name, and the Settings when they hold no error. The records are read
// only when a caller asks: gg run reports each for its own Ticket (A2), so its preflight never opens the State
// Database.
export interface CheckedConfiguration {
  flows: Map<string, DeclaredFlow>;
  configurationErrors: report.Problem[];
  environmentErrors: report.Problem[];
  goneFlowRecords: () => report.Problem[];
  warnings: report.Problem[];
  misfits: Map<string, report.Problem>;
  settings?: config.Settings;
}

// Harness preflight runs over every admitted Flow, since a resumed Execution runs the Flow its record pins, and leaves
// out a misfit, which gg run admits nowhere.
export async function check({
  config: configuration,
  harnesses,
  commonDir,
}: CheckOptions): Promise<CheckedConfiguration> {
  const parsed = settingsModule.parse(configuration);
  const declared = declaredFlows(configuration, harnesses);
  const admitted = [...declared.flows].filter(([name]) => !declared.misfits.has(name));
  const environment = report.newReport();
  if (commonDir !== undefined) stateDatabaseProblems(environment, commonDir);
  const readable = commonDir !== undefined && !environment.errors.length;
  for (const [name, { json }] of admitted)
    await harnessProblems(environment, model.fromJson({ ...json, name }), harnesses);
  return {
    flows: declared.flows,
    configurationErrors: [...(parsed.errors ?? []), ...declared.errors],
    environmentErrors: environment.errors,
    goneFlowRecords: () => (readable ? goneFlowRecords(commonDir, new Set(admitted.map(([name]) => name))) : []),
    warnings: declared.warnings,
    misfits: declared.misfits,
    ...(parsed.settings && { settings: parsed.settings }),
  };
}
