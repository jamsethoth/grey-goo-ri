import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import * as briefs from '../../lib/briefs.ts';
import * as referencePaths from '../../lib/reference-paths.ts';
import * as exampleLayer from '../support/example-layer.ts';

// What a reader of the SchemaNode reads is what assertStrict checked, for any input (#365): it refuses an object it
// cannot fully see, wherever in a schema it reads one (owner, Q1 B and Q2 C).

// An object assertStrict reads a keyword or an entry from, where it sits in the schema, and the refusal it gives there.
interface Site {
  route: string[];
  message: string;
}

// Every such object in a parsed schema: each node, its properties map, and its required and enum lists.
function sites(node: Record<string, unknown>, route: string[] = [], path = '(root)'): Site[] {
  const found: Site[] = [{ route, message: `${path}: schema must be a plain object` }];
  const { properties, required, items } = node;
  if (referencePaths.isRecord(properties)) {
    found.push({ route: [...route, 'properties'], message: `${path}: properties must be a plain object` });
    for (const [key, property] of Object.entries(properties))
      found.push(...sites(property as Record<string, unknown>, [...route, 'properties', key], `${path}.${key}`));
  }
  if (Array.isArray(required))
    found.push({ route: [...route, 'required'], message: `${path}: required must be a list` });
  if (Array.isArray(node.enum))
    found.push({ route: [...route, 'enum'], message: `${path}: enum must be a non-empty list of strings` });
  if (referencePaths.isRecord(items)) found.push(...sites(items, [...route, 'items'], `${path}[]`));
  return found;
}

const copy = (value: object): object => (Array.isArray(value) ? [...(value as unknown[])] : { ...value });
const firstKey = (value: object) => Object.keys(value)[0] ?? 'min';
class Listed extends Array {}

// Each way an object can hold what Object.keys does not show, or show it differently to each read.
const HIDINGS: [string, (value: object) => object, 'any' | 'list'][] = [
  [
    'an inherited key',
    (value) =>
      Object.setPrototypeOf(
        copy(value),
        Object.create(Object.getPrototypeOf(value) as object, { min: { value: 'x', enumerable: true } }),
      ) as object,
    'any',
  ],
  ['an own key that is not enumerable', (value) => Object.defineProperty(copy(value), 'min', { value: 'x' }), 'any'],
  [
    'an own getter',
    (value) => {
      const key = firstKey(value);
      const held = (value as Record<string, unknown>)[key];
      return Object.defineProperty(copy(value), key, { get: () => held, enumerable: true });
    },
    'any',
  ],
  ['a Proxy', (value) => new Proxy(copy(value), {}), 'any'],
  ['an object from another realm', (value) => runInNewContext(`(${JSON.stringify(value)})`) as object, 'any'],
  ['a hole', (value) => Object.assign(copy(value), { length: (value as unknown[]).length + 1 }), 'list'],
  ['a key beyond its elements', (value) => Object.assign(copy(value), { min: 'x' }), 'list'],
  ['a subclass of Array', (value) => Listed.from(value as unknown[]), 'list'],
];

const objectAt = (schema: unknown, path: string[]) =>
  path.reduce<unknown>((node, key) => (node as Record<string, unknown>)[key], schema) as object;

// The schema with the object at `path` replaced.
function placed(schema: unknown, path: string[], value: object) {
  if (!path.length) return value;
  exampleLayer.putAt(schema, path, value);
  return schema;
}

const refusal = (schema: unknown) => {
  try {
    briefs.assertStrict(schema);
    return 'passes';
  } catch (err) {
    return (err as Error).message;
  }
};

for (const [hiding, hide, applies] of HIDINGS) {
  test(`assertStrict refuses ${hiding} at every object it reads, with the refusal of that place`, () => {
    for (const [name, pristine] of Object.entries(exampleLayer.schemas())) {
      const reached = sites(pristine as Record<string, unknown>).filter(
        (site) => applies === 'any' || Array.isArray(objectAt(pristine, site.route)),
      );
      assert.ok(reached.length > 1, name);
      const refusals = reached.map((site) => {
        const schema = structuredClone(pristine);
        return `${site.route.join('.')}: ${refusal(placed(schema, site.route, hide(objectAt(schema, site.route))))}`;
      });
      assert.deepEqual(
        refusals,
        reached.map((site) => `${site.route.join('.')}: ${site.message}`),
        name,
      );
    }
  });
}

// Nothing is hidden in an object with no prototype at all, which JSON writes as it reads (lib/json-value.ts).
test('assertStrict accepts a node or a properties map with no prototype', () => {
  for (const [name, pristine] of Object.entries(exampleLayer.schemas())) {
    for (const site of sites(pristine as Record<string, unknown>)) {
      const schema = structuredClone(pristine);
      const value = objectAt(schema, site.route);
      if (Array.isArray(value)) continue;
      const bare = Object.assign(Object.create(null) as object, value);
      assert.equal(refusal(placed(schema, site.route, bare)), 'passes', `${name} ${site.route.join('.')}`);
    }
  }
});
