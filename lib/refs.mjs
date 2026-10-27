// The one resolver for dotted reference paths (R14e): rule fields, Check parameters, `tests: named`, `with`, and the
// `from` and `pick` of inputs. It types a path by walking a schema-shaped scope, where gg's own facts are nodes too and
// an integer fact may carry `min` and `max` (J15).

// A node of unknown shape, such as a schema that could not be read: every path through it resolves, untyped.
export const ANY = Object.freeze({});

const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parse(path) {
  // Only the type: a YAML value may be self-referencing or lack a callable toString.
  if (typeof path !== 'string') return { error: `the field path must be a string, not ${path === null ? 'null' : typeof path}` };
  if (path === '') return { error: 'the field path is empty' };
  const steps = path.split('.');
  if (steps.includes('')) return { error: `${JSON.stringify(path)} has an empty segment` };
  return { steps };
}

export function read(value, path) {
  const { steps } = parse(path);
  if (!steps) return undefined;
  let v = value;
  for (const key of steps) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, key)) return undefined;
    v = v[key];
  }
  return v;
}

// Own data properties only, so a key such as __proto__ never reaches a prototype.
const own = (o, key, value) => Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });

export function write(value, path, v) {
  const { steps, error } = parse(path);
  if (error) throw new Error(error);
  let o = value;
  for (const key of steps.slice(0, -1)) o = Object.hasOwn(o, key) ? o[key] : own(o, key, {})[key];
  own(o, steps.at(-1), v);
}

export const kindOf = (s) => (s === ANY ? null
  : s.type === 'array' ? { kind: 'list', of: kindOf(s.items) }
    : s.enum ? { kind: 'enum', values: s.enum }
      : { kind: s.type, ...(s.min !== undefined && { min: s.min }), ...(s.max !== undefined && { max: s.max }) });

// A path steps through arrays implicitly: findings.severity is a list of the severity enum.
function walk(node, steps) {
  let lists = 0;
  for (const [i, key] of steps.entries()) {
    while (node.type === 'array') { node = node.items; lists++; }
    if (node === ANY) return { node: ANY };
    if (node.type !== 'object' || !isRecord(node.properties) || !Object.hasOwn(node.properties, key)) return { missing: steps.slice(0, i + 1).join('.') };
    node = node.properties[key];
  }
  for (; lists > 0; lists--) node = { type: 'array', items: node };
  return { node };
}

// The type and node at `path` in `scope`, or an error naming the first segment `scope` lacks.
export function resolve(scope, path, what = 'defined') {
  const { steps, error } = parse(path);
  if (error) return { error };
  const { node, missing } = walk(scope, steps);
  if (missing !== undefined) return { error: `${missing === path ? '' : `${JSON.stringify(path)}: `}${JSON.stringify(missing)} is not ${what}` };
  return { type: kindOf(node), node };
}
