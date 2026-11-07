// `gg doctor`: the validator's Resolved Flow, warnings and errors, printed per Vertex (V1).

import * as config from './config.ts';
import * as rules from './rules.ts';
import type * as graph from './validate/graph.ts';
import * as validator from './validate/index.ts';

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
  return `${edge?.to} (max ${edge?.max ?? 'none'}${exhausted})`;
}
const list = (items: unknown[]) => (items.length ? items.join(', ') : 'none');
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

function table(name: string, rows: unknown[]): string[] {
  if (!rows.length) return [`  ${name}: none`];
  return [
    `  ${name}:`,
    ...rows.map((row, index) => {
      const { when, outcome } = (row ?? {}) as { when?: Record<string, rules.Condition>; outcome?: unknown };
      return `    ${index + 1}. ${rules.conditions(when ?? {})} -> ${outcome}`;
    }),
  ];
}

// Why a Vertex has its access: its Procedure's read-only caps it, or its Agent names none.
function accessNote(vertex: graph.ResolvedVertex, procedure: ShownProcedure | undefined): string {
  if (procedure?.access === 'read-only') return ' (capped by the Procedure)';
  return vertex.agent?.access == null ? ' (default)' : '';
}

function testsLine(tests: unknown): string {
  if (typeof tests === 'object' && tests !== null) return `named ${(tests as { named: unknown }).named}`;
  return String(tests ?? 'none');
}

function procedureLines(procedure: ShownProcedure): string[] {
  const checks = (procedure.actions ?? []).filter((action) => action?.do === 'check') as Value[];
  const claimTokens = Object.entries(procedure.claimTokens).map(([token, claim]) =>
    claim?.stop ? `${token} stops` : `${token} requires ${list(claim?.requires ?? [])}`,
  );
  const shown = checks.map((check) => `${check.id} (${check.kind}${check.command ? ` ${check.command}` : ''})`);
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
      return `    ${name} <- ${input.from.join(' | ')}${pick}${input.optional ? ' (optional)' : ''}`;
    }),
  ];
}

function vertexLines(id: string, vertex: graph.ResolvedVertex, procedure: ShownProcedure | undefined): string[] {
  const agent = vertex.agent ? `${vertex.use ?? 'inline'} (harness ${vertex.agent.harness ?? 'none'})` : 'none';
  const lines = [
    `vertex ${id}`,
    `  procedure: ${vertex.procedure}`,
    `  agent: ${agent}`,
    `  access: ${vertex.access}${accessNote(vertex, procedure)}`,
    `  tests: ${testsLine(vertex.tests)}`,
  ];
  if (procedure) lines.push(...procedureLines(procedure));
  lines.push(`  outcomes: ${list(vertex.outcomes)}`);
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

// Schemas and templates are read through the loader, from the Layer files loadLayers loaded (`config.files`).
export function doctor({ config: layers, harnesses }: { config: config.Config; harnesses: unknown }): {
  text: string;
  exitCode: number;
} {
  const { flows, errors, warnings } = validator.validate(layers, {
    harnesses,
    readSchema: (name) => JSON.parse(config.layerFile(layers.files, name)),
    readTemplate: (name) => config.layerFile(layers.files, name),
  });
  const lines: string[] = [];
  for (const flow of Object.values(flows)) if (flow) lines.push(...flowLines(flow as unknown as ShownFlow));
  for (const warning of warnings) lines.push(`warning: ${warning.at}: ${warning.message}`);
  for (const error of errors) lines.push(`error: ${error.at}: ${error.message}`);
  lines.push(`${plural(errors.length, 'error')}${warnings.length ? `, ${plural(warnings.length, 'warning')}` : ''}`);
  return { text: `${lines.join('\n')}\n`, exitCode: errors.length ? 1 : 0 };
}
