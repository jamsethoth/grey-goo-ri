// `gg doctor`: the validator's Resolved Flow, warnings and errors, printed per Vertex (V1).

import * as config from './config.ts';
import type * as github from './github.ts';
import * as labels from './labels.ts';
import * as rules from './rules.ts';
import type * as graph from './validate/graph.ts';
import * as validator from './validate/index.ts';
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

function target(given: unknown): string {
  if (typeof given === 'string') return given;
  const edge = given as Target | null | undefined;
  if (edge?.end !== undefined) return `end ${edge.end}`;
  const exhausted = edge?.exhausted === undefined ? '' : `, exhausted ${target(edge.exhausted)}`;
  return `${edge?.to ?? 'no target'} (max ${edge?.max ?? 'none'}${exhausted})`;
}
const list = (items: unknown[]) => (items.length ? items.join(', ') : 'none');
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function table(name: string, rows: unknown[]): string[] {
  if (!rows.length) return [`  ${name}: none`];
  return [
    `  ${name}:`,
    ...rows.map((row, index) => {
      const { when, outcome } = (row ?? {}) as { when?: Record<string, rules.Condition>; outcome?: unknown };
      return `    ${index + 1}. ${rules.conditions(when ?? {})} -> ${outcome ?? 'no outcome'}`;
    }),
  ];
}

// Why a Vertex has its access: its Procedure's read-only caps it, or its Agent names none.
function accessNote(vertex: graph.ResolvedVertex, procedure: ShownProcedure | undefined): string {
  if (procedure?.access === 'read-only') return ' (capped by the Procedure)';
  return vertex.agent?.access == null ? ' (default)' : '';
}

function testsLine(tests: unknown): string {
  if (typeof tests === 'object' && tests !== null) return `named ${(tests as { named: unknown }).named ?? 'nothing'}`;
  return String(tests ?? 'none');
}

function procedureLines(procedure: ShownProcedure): string[] {
  const checks = (procedure.actions ?? []).filter((action) => action?.do === 'check') as Value[];
  const claimTokens = Object.entries(procedure.claimTokens).map(([token, claim]) =>
    claim?.stop ? `${token} stops` : `${token} requires ${list((claim?.requires ?? []).map((id) => id ?? 'no id'))}`,
  );
  const shown = checks.map(
    (check) => `${check.id ?? 'no id'} (${check.kind ?? 'no kind'}${check.command ? ` ${check.command}` : ''})`,
  );
  const lines = [
    `  checks: ${list(shown)}`,
    `  claimTokens: ${list(claimTokens)}`,
    ...table('passed', procedure.passed),
    ...table('failed', procedure.failed),
    ...table('stopped', procedure.stopped),
  ];
  if (procedure.otherwise !== null) lines.push(`  otherwise: ${procedure.otherwise}`);
  return lines;
}

// R12d, U5: which route each Outcome takes, unless the Vertex names it, and where a failure's work goes.
function routeLines(vertex: graph.ResolvedVertex): string[] {
  return [
    `  routes:${vertex.outcomes.length ? '' : ' none'}`,
    ...vertex.outcomes.map((outcome) => {
      const routing = Object.hasOwn(vertex.routing, outcome) ? vertex.routing[outcome] : null;
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
      const pick = input.pick === undefined ? '' : `, pick ${input.pick}`;
      return `    ${name} <- ${input.from.join(' | ') || 'no source'}${pick}${input.optional ? ' (optional)' : ''}`;
    }),
  ];
}

function vertexLines(id: string, vertex: graph.ResolvedVertex, procedure: ShownProcedure | undefined): string[] {
  const agent = vertex.agent ? `${vertex.use ?? 'inline'} (harness ${vertex.agent.harness ?? 'none'})` : 'none';
  const lines = [
    `vertex ${id}`,
    `  procedure: ${vertex.procedure ?? 'none'}`,
    `  agent: ${agent}`,
    `  access: ${vertex.access}${accessNote(vertex, procedure)}`,
    `  tests: ${testsLine(vertex.tests)}`,
  ];
  if (procedure) lines.push(...procedureLines(procedure));
  lines.push(`  outcomes: ${list(vertex.outcomes)}`);
  if (vertex.approvalLabels)
    lines.push(`  approval labels: ${[vertex.approvalLabels.await, ...vertex.approvalLabels.decide].join(', ')}`);
  // H11: a Vertex's bound, beside its routes.
  if (vertex.max !== null)
    lines.push(`  max: ${vertex.max}, exhausted ${vertex.exhausted === null ? 'none' : target(vertex.exhausted)}`);
  return [...lines, ...routeLines(vertex), ...inputLines(vertex)];
}

// A Resolved Flow as doctor prints it.
interface ShownFlow {
  name: string;
  actionCap: unknown;
  procedures: Record<string, ShownProcedure>;
  ticket: { entry: unknown; routes: Record<string, unknown>; vertices: Record<string, graph.ResolvedVertex> };
}

function flowLines(flow: ShownFlow): string[] {
  const routes = Object.entries(flow.ticket.routes).map(([outcome, route]) => `${outcome} -> ${target(route)}`);
  const lines = [
    `flow ${flow.name}`,
    `  actionCap: ${flow.actionCap ?? 'none'}`,
    `  entry: ${flow.ticket.entry ?? 'none'}`,
    `  routes: ${list(routes)}`,
  ];
  for (const [id, vertex] of Object.entries(flow.ticket.vertices))
    lines.push('', ...vertexLines(id, vertex, flow.procedures[vertex.procedure as string]));
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

// What gg doctor reads: the merged Layers and the registered Harnesses, and GitHub for the labels a Flow can request.
export interface DoctorOptions {
  config: config.Config;
  harnesses: unknown;
  gh: github.Gh;
  cwd: string;
}

// Schemas and templates are read through the loader, from the Layer files loadLayers loaded (`config.files`).
export async function doctor({ config: layers, harnesses, gh, cwd }: DoctorOptions): Promise<{
  text: string;
  exitCode: number;
}> {
  const validated = validator.validate(layers, {
    harnesses,
    readSchema: (name) => JSON.parse(config.layerFile(layers.files, name)),
    readTemplate: (name) => config.layerFile(layers.files, name),
  });
  const { flows, warnings } = validated;
  // What gg run preflight refuses in the repository Layer, so doctor never passes a Layer run will not (#301).
  const errors = [...validated.errors, ...config.repositoryLayerProblems(layers, config.layerPath(cwd))];
  const lines: string[] = [];
  for (const flow of Object.values(flows)) if (flow) lines.push(...flowLines(flow as unknown as ShownFlow));
  for (const warning of warnings) lines.push(report.line('warning', warning));
  const labelProblems = await labelWarnings(Object.values(flows).filter(Boolean) as unknown as ShownFlow[], {
    gh,
    cwd,
  });
  lines.push(...labelProblems.map((warning) => report.line('warning', warning)));
  for (const error of errors) lines.push(report.line('error', error));
  const warned = warnings.length + labelProblems.length;
  lines.push(`${plural(errors.length, 'error')}${warned ? `, ${plural(warned, 'warning')}` : ''}`);
  return { text: `${lines.join('\n')}\n`, exitCode: errors.length ? 1 : 0 };
}
