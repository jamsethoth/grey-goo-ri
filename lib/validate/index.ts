// The Flow validator (V1): everything the configuration decides, checked before any agent runs, giving each Flow's
// Resolved Flow plus errors and warnings. `gg doctor` and `gg run` admission share it.

import * as refs from '../refs.ts';
import * as flows from './flows.ts';
import * as procedures from './procedures.ts';
import * as references from './references.ts';
import * as report from './report.ts';
import * as templates from './templates.ts';

export { AGENT_KEYS, EDGE_KEYS, FLOW_KEYS, TICKET_KEYS, VERTEX_KEYS } from './flows.ts';
export { INPUT_KEYS } from './inputs.ts';
export { CLAIM_TOKEN_FORMS, PROCEDURE_KEYS } from './procedures.ts';

type Value = Record<string, unknown>;
// What the validator reads beside the configuration: the registered harnesses, and each schema and template a
// Procedure names. `readTemplate`, when given, gives a template's text, so the names each template reads are checked
// (Y20).
export interface Sources {
  harnesses: unknown;
  readSchema: (name: string) => unknown;
  readTemplate?: (name: string) => string;
}

const INHERITED = Object.getOwnPropertyNames(Object.prototype);
const PROTOTYPE = 'is reserved: every object inherits a property of that name from Object.prototype';
const field = (value: unknown, key: string) => (refs.isRecord(value) ? value[key] : undefined);

// Each name the configuration gives that a plain object already has, which as a key is dropped (__proto__) or read as
// the inherited property (H10).
function inheritedNames(config: Value) {
  const problems = report.newReport();
  const name = (location: string, what: string, given: unknown) => {
    if (INHERITED.includes(given as string))
      report.error(problems, location, `${what} ${JSON.stringify(given)} ${PROTOTYPE}`);
  };
  const keys = (value: unknown, location: string, what: string) => {
    for (const [key] of report.entries(value)) name(`${location}.${key}`, what, key);
  };
  keys(config.agents, 'agents', 'Agent');
  for (const [procedureName, proc] of report.entries(config.procedures)) {
    const location = `procedures.${procedureName}`;
    name(location, 'Procedure', procedureName);
    const actions = field(proc, 'actions');
    if (Array.isArray(actions))
      actions.forEach((action, index) => name(`${location}.actions[${index}]`, 'Action id', field(action, 'id')));
    keys(field(proc, 'claimTokens'), `${location}.claimTokens`, 'Claim token');
    for (const table of procedures.TABLES) {
      const rows = field(proc, table);
      if (Array.isArray(rows))
        rows.forEach((row, index) => name(`${location}.${table}[${index}]`, 'outcome', field(row, 'outcome')));
    }
    name(`${location}.otherwise`, 'otherwise', field(proc, 'otherwise'));
  }
  for (const [flowName, declared] of report.entries(config.flows)) {
    const location = `flows.${flowName}`;
    name(location, 'Flow', flowName);
    const ticket = field(declared, 'ticket');
    keys(field(ticket, 'routes'), `${location}.ticket.routes`, 'route key');
    for (const [id, vertex] of report.entries(field(ticket, 'vertices'))) {
      const vertexLocation = `${location}.ticket.vertices.${id}`;
      name(vertexLocation, 'Vertex id', id);
      keys(field(vertex, 'inputs'), `${vertexLocation}.inputs`, 'input');
      keys(field(vertex, 'route'), `${vertexLocation}.route`, 'route key');
    }
  }
  return problems.errors;
}

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
    if (!refs.isRecord(agent)) report.error(problems, location, 'an Agent must be an object');
    else {
      report.unknownKeys(problems, agent, flows.AGENT_KEYS, location);
      flows.checkHarness({ report: problems, harnesses }, `agent ${name}`, agent.harness, location);
      flows.checkAccess(problems, `${location}.access`, agent.access);
    }
    if (problems.errors.length > before) failedAgents.add(name);
    if (!usedAgents.has(name)) report.warn(problems, location, `agent ${name} is used by no Vertex`);
  }
  return failedAgents;
}

function checkProcedures(problems: report.Report, config: Value, readSchema: Sources['readSchema']) {
  const declaring = { report: problems, readSchema, schemas: new Map(), commands: config.commands };
  const checkedProcedures: Record<string, procedures.CheckedProcedure | undefined> = {};
  for (const [name, declaration] of report.entries(config.procedures))
    checkedProcedures[name] = procedures.checkProcedure(declaring, name, declaration);
  // Each Procedure's references typed alone; each Vertex using it types those that read `inputs`.
  const procedureFalls: Record<string, Partial<Record<procedures.Table, string[]>>> = {};
  for (const proc of Object.values(checkedProcedures)) {
    if (!proc) continue;
    procedureFalls[proc.name] = references.runRefs(problems, proc, {
      inputs: refs.ANY,
      optional: () => false,
      atVertex: false,
      locate: (where) => `${proc.location}.${where}`,
    });
  }
  return { checkedProcedures, procedureFalls };
}

export function validate(config: unknown, { harnesses, readSchema, readTemplate }: Sources) {
  const problems = report.newReport();
  if (!refs.isRecord(config)) {
    report.error(problems, '(root)', 'the configuration must be an object');
    return { flows: {}, ...problems };
  }
  // Every later check keys plain objects by the configuration's names, so none runs while one is inherited (H10).
  const inherited = inheritedNames(config);
  if (inherited.length) return { flows: {}, errors: inherited, warnings: [] };
  if (config.procedures !== undefined && !refs.isRecord(config.procedures))
    report.error(problems, 'procedures', 'procedures must be an object from name to Procedure');
  if (config.agents !== undefined && !refs.isRecord(config.agents))
    report.error(problems, 'agents', 'agents must be an object from name to Agent');
  const { checkedProcedures, procedureFalls } = checkProcedures(problems, config, readSchema);
  const sharedErrors = problems.errors.length;
  const failedAgents = checkAgents(problems, config, harnesses);
  if (config.flows !== undefined && !refs.isRecord(config.flows))
    report.error(problems, 'flows', 'flows must be an object from name to Flow');
  else if (!Object.keys(config.flows ?? {}).length) {
    report.error(
      problems,
      'flows',
      'no Flow is declared; docs/requests/node-harness-dag.md tables the keys of a Flow (3.3) and of a Procedure (3.4)',
    );
  }
  const reader = templates.templateReader(readTemplate);
  const checking = {
    report: problems,
    config,
    procedures: checkedProcedures,
    procedureFalls,
    failedAgents,
    harnesses,
    reader,
    sharedErrors,
  };
  const resolved: Record<string, ReturnType<typeof flows.checkFlow>> = {};
  for (const [name, declaration] of report.entries(config.flows))
    resolved[name] = flows.checkFlow(checking, name, declaration);
  return { flows: resolved, errors: report.dedupe(problems.errors), warnings: report.dedupe(problems.warnings) };
}
