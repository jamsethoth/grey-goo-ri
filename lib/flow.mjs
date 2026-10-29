import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROCEDURES } from './procedures.mjs';

const VERTEX_FIELDS = new Set(['use', 'procedure', 'options', 'inputs', 'route']);

// Expands each Vertex's `use` into an `agent`; Agent fields written on the Vertex override the library Agent's. A Vertex
// without `use` (publish) runs no agent, so its `agent` is null. The Flow's `routes` apply to every Vertex (T3).
export function resolveFlow(config, name = 'default') {
  const { plan, ticket } = config.flows[name];
  const vertices = {};
  for (const [id, vertex] of Object.entries(ticket.vertices)) {
    if (vertex.use !== undefined && !Object.hasOwn(config.agents, vertex.use)) throw new Error(`vertex ${id} uses unknown agent "${vertex.use}"`);
    if (!Object.hasOwn(PROCEDURES, vertex.procedure)) throw new Error(`vertex ${id} names unknown procedure "${vertex.procedure}"`);
    const resolved = { options: {} };
    const agent = vertex.use === undefined ? null : structuredClone(config.agents[vertex.use]);
    for (const [key, value] of Object.entries(vertex)) {
      if (VERTEX_FIELDS.has(key)) { if (key !== 'use') resolved[key] = value; } else if (agent) agent[key] = value;
    }
    // An Agent may name no harness until a user or repo Layer supplies one; admission rejects it (T20).
    if (agent) for (const key of ['harness', 'model', 'effort']) agent[key] ??= null;
    vertices[id] = { agent, ...resolved };
  }
  return { name, plan, ticket: { entry: ticket.entry, routes: ticket.routes ?? {}, vertices } };
}

export function writeResolved(runDir, resolved, hash) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'flow.json'), `${JSON.stringify(resolved, null, 2)}\n`);
  writeFileSync(join(runDir, 'config-hash.txt'), `${hash}\n`);
}
