// The node readers lib/record-read.ts builds a record's row from: each reads one node of the parsed row, gives a
// typed value or throws a RowFieldError naming the node's path from the row.
import * as jsonValue from './json-value.ts';
import * as referencePaths from './reference-paths.ts';

// A node of the parsed row, with its path from the row: `cursor.visit`, `writeAheadLog[2].payload`.
export interface Node {
  value: unknown;
  path: string;
}
export type Read<Value> = (node: Node) => Value;

export class RowFieldError extends Error {
  constructor(node: Node, problem: string) {
    super(`its ${node.path} ${problem}`);
    this.name = 'RowFieldError';
  }
}

const refuse = (node: Node, problem: string): never => {
  throw new RowFieldError(node, problem);
};
const child = (node: Node, key: string, value: unknown): Node => ({
  value,
  path: node.path ? `${node.path}.${key}` : key,
});

export const text: Read<string> = (node) =>
  typeof node.value === 'string' ? node.value : refuse(node, 'is not a string');
export const count: Read<number> = (node) =>
  typeof node.value === 'number' ? node.value : refuse(node, 'is not a number');
export const flag: Read<boolean> = (node) =>
  typeof node.value === 'boolean' ? node.value : refuse(node, 'is not true or false');
// What JSON.parse gave is JSON at every depth: the checked copy only types it.
export const json: Read<jsonValue.JsonValue> = (node) => jsonValue.checked(node.value, node.path);

export const nullable =
  <Value>(read: Read<Value>): Read<Value | null> =>
  (node) =>
    node.value === null ? null : read(node);

export const list =
  <Value>(read: Read<Value>): Read<Value[]> =>
  (node) =>
    Array.isArray(node.value)
      ? node.value.map((item: unknown, i) => read({ value: item, path: `${node.path}[${i}]` }))
      : refuse(node, 'is not a list');

// An object keyed by name, as a Map or an open Record is saved. Object.fromEntries defines own keys, so a name such as
// __proto__ stays data.
export const keyed =
  <Value>(read: Read<Value>): Read<Record<string, Value>> =>
  (node) => {
    const { value } = node;
    if (!referencePaths.isRecord(value)) return refuse(node, 'is not an object');
    return Object.fromEntries(Object.entries(value).map(([key, held]) => [key, read(child(node, key, held))]));
  };

// A string from a closed set: the keys of `members`, a Record its type holds to the whole set.
export function oneOf<Member extends string>(members: Record<Member, unknown>): Read<Member> {
  const isMember = (value: string): value is Member => Object.hasOwn(members, value);
  return (node) => {
    const value = text(node);
    return isMember(value) ? value : refuse(node, `is not one of ${Object.keys(members).join(', ')}`);
  };
}

type Field = (key: string) => Node;
type Has = (key: string) => boolean;
type Rest = () => Record<string, jsonValue.JsonValue>;

// An object read field by field. The keys `read` reads, or asks about with `has`, are the ones its type declares: one
// it reads that the row lacks is missing, and one it never asks about is undeclared, unless `read` takes the `rest`,
// every other key as JSON, as `open` does. `rest` is taken last, once every declared key is read.
export const object =
  <Value>(read: (field: Field, has: Has, rest: Rest) => Value): Read<Value> =>
  (node) => {
    const { value } = node;
    if (!referencePaths.isRecord(value)) return refuse(node, 'is not an object');
    const declared = new Set<string>();
    const has: Has = (key) => declared.add(key) && Object.hasOwn(value, key);
    const field: Field = (key) =>
      has(key) ? child(node, key, value[key]) : refuse(child(node, key, undefined), 'is missing');
    const others = () => Object.entries(value).filter(([key]) => !declared.has(key));
    let open = false;
    const rest: Rest = () => {
      open = true;
      return Object.fromEntries(others().map(([key, held]) => [key, json(child(node, key, held))]));
    };
    const result = read(field, has, rest);
    const [undeclared] = open ? [] : others();
    return undeclared ? refuse(child(node, undeclared[0], undefined), 'is not declared') : result;
  };

// An object its type leaves open: the keys `read` reads, then every other key as JSON.
export const open = <Value extends object>(
  read: (field: Field, has: Has) => Value,
): Read<Value & Record<string, jsonValue.JsonValue>> =>
  object((field, has, rest) => Object.assign(read(field, has), rest()));

// A union told apart by its keys: the one form whose keys the object holds is read. An object that fits no form, or
// more than one, is not of the union. Its value is the union of its forms' values.
export interface Form<Value> {
  required: string[];
  optional?: string[];
  read: Read<Value>;
}
export const variant =
  <Values extends unknown[]>(
    what: string,
    forms: { [Index in keyof Values]: Form<Values[Index]> },
  ): Read<Values[number]> =>
  (node) => {
    const { value } = node;
    if (!referencePaths.isRecord(value)) return refuse(node, 'is not an object');
    const keys = Object.keys(value);
    const fits = forms.filter(
      ({ required, optional = [] }) =>
        required.every((key) => keys.includes(key)) &&
        keys.every((key) => required.includes(key) || optional.includes(key)),
    );
    return fits.length === 1 ? fits[0].read(node) : refuse(node, `is not ${what}`);
  };

// A union told apart by the value of one key: the form `forms` holds under that value reads the object. Any other value
// is refused, or read by `other` when it is given. Its value is the union of its forms' values.
export const tagged =
  <Values extends Record<string, unknown>, Other = never>(
    key: string,
    forms: { [Tag in keyof Values]: Read<Values[Tag]> },
    other?: Read<Other>,
  ): Read<Values[keyof Values] | Other> =>
  (node) => {
    const { value } = node;
    if (!referencePaths.isRecord(value)) return refuse(node, 'is not an object');
    const tag = child(node, key, value[key]);
    if (!Object.hasOwn(value, key)) return refuse(tag, 'is missing');
    if (other && !(typeof tag.value === 'string' && Object.hasOwn(forms, tag.value))) return other(node);
    return forms[oneOf(forms)(tag)](node);
  };
