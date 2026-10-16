import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PERSONAS_DIR } from './config.mjs';
import { PROCEDURES } from './procedures.mjs';

const VERTEX_FIELDS = new Set(['use', 'procedure', 'options', 'then', 'route']);

// Expands each Vertex's `use` into a `node`; Node fields written on the Vertex override the library Node's.
export function resolveFlow(config, name = 'default') {
  const { plan, ticket } = config.flows[name];
  const vertices = {};
  for (const [id, vertex] of Object.entries(ticket.vertices)) {
    const library = config.nodes[vertex.use];
    if (!library) throw new Error(`vertex ${id} uses unknown node "${vertex.use}"`);
    if (!PROCEDURES[vertex.procedure]) throw new Error(`vertex ${id} names unknown procedure "${vertex.procedure}"`);
    const resolved = { options: {} };
    const node = structuredClone(library);
    for (const [key, value] of Object.entries(vertex)) {
      if (VERTEX_FIELDS.has(key)) { if (key !== 'use') resolved[key] = value; } else node[key] = value;
    }
    // shortcut: Personas resolve against the shipped defaults only; user and repo Layers arrive in slice 5.
    node.persona = join(PERSONAS_DIR, node.persona);
    vertices[id] = { node, ...resolved };
  }
  return { name, plan, ticket: { entry: ticket.entry, vertices } };
}

export function writeResolved(runDir, resolved, hash) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'flow.json'), `${JSON.stringify(resolved, null, 2)}\n`);
  writeFileSync(join(runDir, 'config-hash.txt'), `${hash}\n`);
}
