// `gg doctor`: the validator's Resolved Flow, warnings and errors, printed per Vertex (V1).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { layerPath } from './config.mjs';
import { conditions } from './rules.mjs';
import { validate } from './validate.mjs';

const target = (t) => (typeof t === 'string' ? t
  : t?.end !== undefined ? `end ${t.end}`
    : `${t?.to} (max ${t?.max ?? 'none'}${t?.exhausted === undefined ? '' : `, exhausted ${target(t.exhausted)}`})`);
const list = (items) => (items.length ? items.join(', ') : 'none');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function table(name, rows) {
  if (!rows.length) return [`  ${name}: none`];
  return [`  ${name}:`, ...rows.map((r, i) => `    ${i + 1}. ${conditions(r?.when ?? {})} -> ${r?.outcome}`)];
}

function vertexLines(id, v, procedure) {
  const lines = [`vertex ${id}`, `  procedure: ${v.procedure}`];
  lines.push(`  agent: ${v.agent ? `${v.use ?? 'inline'} (harness ${v.agent.harness ?? 'none'})` : 'none'}`);
  lines.push(`  access: ${v.access ?? 'none'}${procedure?.access === 'read-only' ? ' (capped by the Procedure)' : ''}`);
  lines.push(`  tests: ${typeof v.tests === 'object' && v.tests !== null ? `named ${v.tests.named}` : v.tests ?? 'none'}`);
  if (procedure) {
    const checks = (procedure.actions ?? []).filter((a) => a?.do === 'check');
    lines.push(`  checks: ${list(checks.map((c) => `${c.id} (${c.kind}${c.command ? ` ${c.command}` : ''})`))}`);
    lines.push(`  claims: ${list(Object.entries(procedure.claims).map(([token, c]) => (c?.stop ? `${token} stops`
      : `${token} requires ${list(c?.requires ?? [])}`)))}`);
    lines.push(...table('passed', procedure.passed), ...table('failed', procedure.failed), ...table('stopped', procedure.stopped));
    if (procedure.otherwise !== null) lines.push(`  otherwise: ${procedure.otherwise}`);
  }
  lines.push(`  outcomes: ${list(v.outcomes)}`);
  // R12d, U5: which route each Outcome takes, unless the Vertex names it, and where a failure's work goes.
  lines.push(`  routes:${v.outcomes.length ? '' : ' none'}`, ...v.outcomes.map((o) => {
    const r = v.routing[o];
    if (!r) return `    ${o} -> unrouted`;
    return `    ${o} -> ${target(r.target)}${r.by === 'Vertex route' ? '' : ` (${r.by})`}${r.work ? `; work ${r.work}` : ''}`;
  }));
  const inputs = Object.entries(v.inputs);
  if (!inputs.length) lines.push('  inputs: none');
  else {
    lines.push('  inputs:');
    for (const [name, i] of inputs) {
      lines.push(`    ${name} <- ${i.from.join(' | ')}${i.pick === undefined ? '' : `, pick ${i.pick}`}${i.optional ? ' (optional)' : ''}`);
    }
  }
  return lines;
}

export function doctor({ config, harnesses, readSchema }) {
  const { flows, errors, warnings } = validate(config, { harnesses, readSchema });
  const lines = [];
  for (const flow of Object.values(flows)) {
    if (!flow) continue;
    lines.push(`flow ${flow.name}`, `  plan: ${flow.plan}`, `  actionCap: ${flow.actionCap ?? 'none'}`, `  entry: ${flow.ticket.entry ?? 'none'}`,
      `  routes: ${list(Object.entries(flow.ticket.routes).map(([outcome, t]) => `${outcome} -> ${target(t)}`))}`);
    for (const [id, v] of Object.entries(flow.ticket.vertices)) lines.push('', ...vertexLines(id, v, flow.procedures[v.procedure]));
    lines.push('');
  }
  for (const w of warnings) lines.push(`warning: ${w.at}: ${w.message}`);
  for (const e of errors) lines.push(`error: ${e.at}: ${e.message}`);
  lines.push(`${plural(errors.length, 'error')}${warnings.length ? `, ${plural(warnings.length, 'warning')}` : ''}`);
  return { text: `${lines.join('\n')}\n`, exitCode: errors.length ? 1 : 0 };
}

// Schemas are files beside the repository Layer that names them (P3).
export const layerReader = (repoRoot) => (name) => JSON.parse(readFileSync(join(dirname(layerPath(repoRoot)), name), 'utf8'));
