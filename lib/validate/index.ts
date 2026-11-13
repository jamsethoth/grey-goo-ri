// The Flow validator (V1): everything the configuration decides, checked before any agent runs, giving each Flow's
// Resolved Flow plus errors and warnings. `gg doctor` and `gg run` admission share it.

import * as referencePaths from '../reference-paths.ts';
import * as flows from './flows.ts';
import * as procedures from './procedures.ts';
import * as references from './references.ts';
import * as report from './report.ts';
import * as templates from './templates.ts';

export { AGENT_KEYS, EDGE_KEYS, FLOW_KEYS, TICKET_KEYS, VERTEX_KEYS } from './flows.ts';
export { INPUT_KEYS } from './inputs.ts';
export { CLAIM_TOKEN_FORMS, PROCEDURE_KEYS } from './procedures.ts';

type Value = Record<string, unknown>;
// What a Flow uses beyond its Resolved Flow: the files its Agents and Procedures name, which its Pinned Configuration
// takes, and the commands its Checks run, each once, in the order the Flow first uses them.
export interface Uses {
  files: string[];
  commands: string[];
}
// What the validator reads beside the configuration: the registered harnesses, and each schema and template a
// Procedure names. `readTemplate`, when given, gives a template's text, so the names each template reads are checked
// (Y20). `contract` is the repository's commands and labelPrefix, which a Flow from the user's directory runs under;
// the configuration's own when not given.
export interface Sources {
  harnesses: unknown;
  readSchema: (name: string) => unknown;
  readTemplate?: (name: string) => string;
  contract?: { commands?: unknown; labelPrefix?: unknown };
}

const field = (value: unknown, key: string) => (referencePaths.isRecord(value) ? value[key] : undefined);

// Every declared Agent is checked once, used or not; its errors hold only the Flows that use it (H6).
function checkAgents(problems: report.Report, config: Value, harnesses: unknown) {
  const failedAgents = new Set<unknown>();
  const usedAgents = new Set(
    report
      .entries(config.flows)
      .flatMap(([, declared]) =>
        report.entries(field(field(declared, 'ticket'), 'vertices')).map(([, vertex]) => field(vertex, 'use')),
      ),
  );
  for (const [name, agent] of report.entries(config.agents)) {
    const location = `agents.${name}`;
    const before = problems.errors.length;
    report.checkName(problems, location, name, { what: 'Agent', carried: false });
    if (!referencePaths.isRecord(agent))
      report.error(problems, location, 'not-an-object', 'an Agent must be an object');
    else {
      report.unknownKeys(problems, agent, flows.AGENT_KEYS, location);
      flows.checkHarness({ report: problems, harnesses }, { agent: name }, agent.harness, location);
      flows.checkAccess(problems, `${location}.access`, agent.access);
    }
    if (problems.errors.length > before) failedAgents.add(name);
    if (!usedAgents.has(name))
      report.warn(problems, location, 'unused-agent', `agent ${name} is used by no Vertex`, { agent: name });
  }
  return failedAgents;
}

// What a Procedure is checked against: its schemas, and the commands the repository declares.
interface ProcedureSources {
  readSchema: Sources['readSchema'];
  commands: unknown;
}

function checkProcedures(problems: report.Report, config: Value, { readSchema, commands }: ProcedureSources) {
  const declaring = { report: problems, readSchema, schemas: new Map(), commands };
  const checkedProcedures = new Map<string, procedures.CheckedProcedure | undefined>();
  for (const [name, declaration] of report.entries(config.procedures))
    checkedProcedures.set(name, procedures.checkProcedure(declaring, name, declaration));
  // Each Procedure's references typed alone; each Vertex using it types those that read `inputs`.
  const procedureFalls = new Map<string, Partial<Record<procedures.TableName, string[]>>>();
  for (const proc of checkedProcedures.values()) {
    if (!proc) continue;
    const falls = references.checkReferences(problems, proc, {
      inputs: referencePaths.ANY,
      optional: () => false,
      vertex: null,
    });
    procedureFalls.set(proc.name, falls);
  }
  return { checkedProcedures, procedureFalls };
}

// In a configuration file null is never a value, where a missing key is inherited, optional or required (#298). Every
// null is reported at its path, and the check of the key it sits on still runs on it.
function reportNulls(problems: report.Report, value: unknown, location: string) {
  if (value === null) {
    report.error(
      problems,
      location,
      'null-value',
      'null is not a value in a configuration file; set a value or leave the key out',
    );
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => reportNulls(problems, item, `${location}[${index}]`));
  } else if (referencePaths.isRecord(value)) {
    for (const [key, entry] of Object.entries(value))
      reportNulls(problems, entry, location === '' ? key : `${location}.${key}`);
  }
}

export function validate(config: unknown, { harnesses, readSchema, readTemplate, contract }: Sources) {
  const problems = report.newReport();
  if (!referencePaths.isRecord(config)) {
    report.error(problems, '', 'not-an-object', 'the configuration must be an object');
    return { flows: {}, declared: {}, uses: {}, ...problems };
  }
  // Null errors come first in the report but are not shared errors: the key's own check holds the Flow a null breaks.
  const nulls = report.newReport();
  reportNulls(nulls, config, '');
  if (config.procedures !== undefined && !referencePaths.isRecord(config.procedures))
    report.error(problems, 'procedures', 'not-an-object', 'procedures must be an object from name to Procedure');
  if (config.agents !== undefined && !referencePaths.isRecord(config.agents))
    report.error(problems, 'agents', 'not-an-object', 'agents must be an object from name to Agent');
  const { commands, labelPrefix } = contract ?? config;
  const { checkedProcedures, procedureFalls } = checkProcedures(problems, config, { readSchema, commands });
  const sharedErrors = problems.errors.length;
  const failedAgents = checkAgents(problems, config, harnesses);
  if (config.flows !== undefined && !referencePaths.isRecord(config.flows))
    report.error(problems, 'flows', 'not-an-object', 'flows must be an object from name to Flow');
  else if (!Object.keys(config.flows ?? {}).length) {
    report.error(
      problems,
      'flows',
      'no-flow-declared',
      "no Flow is declared; run gg init to write the example Flow into the repository's .agents/gg/",
    );
  }
  const reader = templates.templateReader(readTemplate);
  const checking = {
    report: problems,
    config,
    labelPrefix,
    procedures: checkedProcedures,
    procedureFalls,
    failedAgents,
    harnesses,
    reader,
    sharedErrors,
  };
  // Built from entries, so a Flow such as __proto__ is an own key.
  const resolved = Object.fromEntries(
    report.entries(config.flows).map(([name, declaration]) => [name, flows.checkFlow(checking, name, declaration)]),
  );
  const uses: Record<string, Uses> = Object.fromEntries(
    Object.keys(resolved).map((name) => [name, { files: [], commands: [] }]),
  );
  return {
    flows: resolved,
    declared: resolved,
    uses,
    errors: report.dedupe([...nulls.errors, ...problems.errors]),
    warnings: report.dedupe(problems.warnings),
  };
}
