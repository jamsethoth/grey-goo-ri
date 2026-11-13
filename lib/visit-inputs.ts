// The Vertex inputs a Visit pins at its entry (S4, T6), read from the outputs of the Visits before it.
import type * as record from './record.ts';
import * as referencePaths from './reference-paths.ts';
import type * as inputs from './validate/inputs.ts';
import type * as visit from './visit.ts';

// Each input at Visit entry: the value from the latest Visit that produced any of its sources, with that Vertex, Visit
// and Action. An optional input none produced is absent (T10); a required one stops the Execution, which admission
// prevents by checking inputs on every route (Q7, H1-H4), so this is a backstop.
export function resolveInputs(
  executionRecord: record.ExecutionRecord,
  vertexId: string,
  declared: Record<string, inputs.ResolvedInput> = {},
): Record<string, visit.VertexInput> {
  return Object.fromEntries(
    Object.entries(declared).map(([name, { from, optional, pick }]) => {
      const sources = [from].flat().map((ref) => {
        const [vertex, action, ...path] = referencePaths.parse(ref).steps ?? [];
        return { vertex, action, path: path.join('.') };
      });
      for (const output of executionRecord.outputs.toReversed()) {
        for (const source of sources) {
          const matches = output.vertex === source.vertex && output.action === source.action;
          if (!matches) continue;
          // `<vertex>.rescue` names the whole output, with no path into it (W3).
          const value = source.path ? referencePaths.read(output.value, source.path) : output.value;
          if (value === undefined) continue;
          const picked =
            pick === undefined ? value : (value as unknown[]).map((item) => referencePaths.read(item, pick));
          return [
            name,
            { value: picked, vertex: output.vertex, visit: output.visit, action: output.action, absent: false },
          ];
        }
      }
      if (!optional)
        throw new Error(`${vertexId}'s input ${name} has no value: no Visit produced ${[from].flat().join(' or ')}`);
      return [name, { value: null, vertex: null, visit: null, action: null, absent: true }];
    }),
  );
}
