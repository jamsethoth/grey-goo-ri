// The Flow validator (V1): everything the configuration decides, checked before any agent runs, giving each Flow's
// Resolved Flow plus errors and warnings. `gg doctor` and `gg run` admission share it.

import type * as model from '../model.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as declaredFlows from './declared.ts';
import * as agentChecks from './agents.ts';
import * as flows from './flows.ts';
import * as procedures from './procedures.ts';
import * as references from './references.ts';
import * as report from './report.ts';
import * as templates from './templates.ts';

export { AGENT_KEYS } from './agents.ts';
export { EDGE_KEYS } from './routes.ts';
export { FLOW_KEYS, TICKET_KEYS, VERTEX_KEYS } from './flows.ts';
export { INPUT_KEYS } from './inputs.ts';
export { CLAIM_TOKEN_FORMS } from './claim-tokens.ts';
export { PROCEDURE_KEYS } from './procedures.ts';
export type { Uses } from './declared.ts';

type Value = Record<string, unknown>;

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

// The Agents the Flows' Vertices name by `use`, whatever their shape.
const usedAgentsOf = (config: Value) =>
  new Set(
    report
      .entries(config.flows)
      .flatMap(([, declared]) =>
        report.entries(field(field(declared, 'ticket'), 'vertices')).map(([, vertex]) => field(vertex, 'use')),
      ),
  );

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
  const { failedAgents, agents } = agentChecks.checkAgents(problems, config, harnesses, usedAgentsOf(config));
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
    agents,
    harnesses,
    reader,
    sharedErrors,
  };
  // Built from entries, so a Flow such as __proto__ is an own key.
  const checkedFlows = report
    .entries(config.flows)
    .map(([name, declaration]) => [name, flows.checkFlow(checking, name, declaration)] as const);
  const given = <Part>(part: (checked: NonNullable<ReturnType<typeof flows.checkFlow>>) => Part | undefined) =>
    Object.fromEntries(
      checkedFlows.flatMap(([name, checked]) => {
        const found = checked && part(checked);
        return found === undefined ? [] : [[name, found] as const];
      }),
    );
  return {
    flows: given<model.ResolvedFlowJson>((checked) => checked.resolved),
    declared: given<model.DeclaredFlowJson>((checked) => checked.declared),
    uses: given<declaredFlows.Uses>((checked) => checked.uses),
    errors: report.dedupe([...nulls.errors, ...problems.errors]),
    warnings: report.dedupe(problems.warnings),
  };
}
