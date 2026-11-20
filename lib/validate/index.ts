// The Flow validator (V1): everything the configuration decides, checked before any agent runs, giving each Flow's
// Resolved Flow plus errors and warnings. `gg doctor` and `gg run` admission share it.

import type * as model from '../model.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as declaredFlows from './declared.ts';
import * as agentChecks from './agents.ts';
import * as flows from './flows.ts';
import * as nullValues from './null-values.ts';
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

// A command named by a string fits one repository and not another; a malformed one is an error anywhere.
export const isMissingCommand = (problem: report.Problem): boolean =>
  problem.code === 'undeclared-command' && typeof problem.params?.command === 'string';

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

// The Procedures checked against their schemas and the commands the repository declares; one refused holds only the
// Vertices naming it (#449, Q3 A).
function checkProcedures(problems: report.Report, config: Value, readSchema: Sources['readSchema'], commands: unknown) {
  const declaring = { report: problems, readSchema, schemas: new Map(), commands };
  const checkedProcedures = new Map<string, procedures.CheckedProcedure | undefined>();
  for (const [name, declaration] of report.entries(config.procedures))
    checkedProcedures.set(name, procedures.checkProcedure(declaring, name, declaration));
  // Each Procedure's references typed alone, an error there refusing it; each Vertex using it types those that read
  // `inputs`, an error there holding only that Vertex (#454, Q2 A).
  const procedureFalls = new Map<string, Partial<Record<procedures.TableName, string[]>>>();
  for (const procedure of checkedProcedures.values()) {
    if (!procedure) continue;
    const before = problems.errors.length;
    const falls = references.checkReferences(problems, procedure, {
      inputs: referencePaths.ANY,
      optional: () => false,
      vertex: null,
    });
    procedureFalls.set(procedure.name, falls);
    procedure.refused ??= report.reportedSince(problems, before);
  }
  return { procedures: checkedProcedures, procedureFalls };
}

export function validate(config: unknown, { harnesses, readSchema, readTemplate, contract }: Sources) {
  const problems = report.newReport();
  if (!referencePaths.isRecord(config)) {
    report.error(problems, '', 'not-an-object', 'the configuration must be an object');
    return { flows: {}, declared: {}, uses: {}, ...problems };
  }
  // Every null first in the report, including those no check reads; each check that judges one also reports it, and
  // the two merge (#454, Q3 A).
  const nulls = report.newReport();
  nullValues.reportNulls(nulls, config, '');
  if (config.procedures !== undefined && !referencePaths.isRecord(config.procedures))
    report.error(problems, 'procedures', 'not-an-object', 'procedures must be an object from name to Procedure');
  if (config.agents !== undefined && !referencePaths.isRecord(config.agents))
    report.error(problems, 'agents', 'not-an-object', 'agents must be an object from name to Agent');
  const { commands, labelPrefix } = contract ?? config;
  const procedureChecks = checkProcedures(problems, config, readSchema, commands);
  const { agents } = agentChecks.checkAgents(problems, config, harnesses, usedAgentsOf(config));
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
    ...procedureChecks,
    agents,
    harnesses,
    reader,
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
