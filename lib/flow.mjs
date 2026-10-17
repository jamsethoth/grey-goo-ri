import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROCEDURES } from './procedures.mjs';

const VERTEX_FIELDS = new Set(['use', 'procedure', 'options', 'then', 'route']);

// Expands each Vertex's `use` into a `node`; Node fields written on the Vertex override the library Node's.
export function resolveFlow(config, name = 'default') {
  const { plan, ticket } = config.flows[name];
  const vertices = {};
  for (const [id, vertex] of Object.entries(ticket.vertices)) {
    if (!Object.hasOwn(config.nodes, vertex.use)) throw new Error(`vertex ${id} uses unknown node "${vertex.use}"`);
    const library = config.nodes[vertex.use];
    if (!Object.hasOwn(PROCEDURES, vertex.procedure)) throw new Error(`vertex ${id} names unknown procedure "${vertex.procedure}"`);
    const resolved = { options: {} };
    const node = structuredClone(library);
    for (const [key, value] of Object.entries(vertex)) {
      if (VERTEX_FIELDS.has(key)) { if (key !== 'use') resolved[key] = value; } else node[key] = value;
    }
    // A Node may name no harness until a user or repo Layer supplies one; admission rejects it (T20).
    for (const key of ['harness', 'model', 'effort']) node[key] ??= null;
    vertices[id] = { node, ...resolved };
  }
  return { name, plan, ticket: { entry: ticket.entry, vertices } };
}

export function writeResolved(runDir, resolved, hash) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'flow.json'), `${JSON.stringify(resolved, null, 2)}\n`);
  writeFileSync(join(runDir, 'config-hash.txt'), `${hash}\n`);
}
