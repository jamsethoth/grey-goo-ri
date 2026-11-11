// The JSON gg saves: its type, and the one function every save path serializes through (#342). tsc refuses a value
// whose type could hold what JSON cannot, and the same call refuses such a value at run time, naming the path to it.

// A value JSON.parse gives: what configuration, a Structured Response and a Harness's output are.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// A type as a save takes it: itself where JSON holds every value of it, with `never` at each place that could hold
// what JSON cannot: a Map, a Set, a function, a symbol, a bigint, or an `unknown` or `any`, which hide any of them. It
// reads an interface property by property, which a plain JsonValue parameter cannot: an interface has no index
// signature (type-fest's Jsonify pattern, whose own mapping lets `unknown` through). Only JsonValue itself is taken
// whole, which also ends the walk of its own recursion: an object or a list is read member by member, since
// `{ value: any }` is assignable to JsonValue. An `undefined` is left to the run-time check, which knows a property
// not given from a list's lost element.
export type JsonChecked<Value> = unknown extends Value
  ? never
  : [JsonValue] extends [Value]
    ? Value
    : Value extends string | number | boolean | null | undefined
      ? Value
      : Value extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | ((...parameters: never[]) => unknown)
        ? never
        : Value extends object
          ? { [Key in keyof Value]: JsonChecked<Value[Key]> }
          : never;

const named = (name: string): string => `${/^[AEIOU]/.test(name) ? 'an' : 'a'} ${name}`;

// What a value is when JSON cannot hold it, whatever it holds in turn; null for one it can.
function lost(value: unknown): string | null {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  // JSON writes NaN and the infinities as null.
  if (typeof value === 'number') return Number.isFinite(value) ? null : String(value);
  if (typeof value !== 'object') return value === undefined ? 'undefined' : named(typeof value);
  const prototype: unknown = Object.getPrototypeOf(value);
  const plain = Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
  // JSON writes a Map, a Set or an Error as {}, and any other class instance as something a load does not give back.
  return plain ? null : named((value as { constructor?: { name?: string } }).constructor?.name || 'class instance');
}

// The value copied as JSON holds it, each property read once. `within` holds the objects the value is inside.
function copied(value: unknown, path: string, what: string, within: object[]): JsonValue {
  const refuse = (problem: string): never => {
    throw new Error(`${what}: ${path || 'the value'} ${problem}, which JSON cannot hold`);
  };
  const kind = lost(value);
  if (kind) refuse(`is ${kind}`);
  if (value === null || typeof value !== 'object') return value as JsonValue;
  if (within.includes(value)) refuse('holds itself');
  const inside = [...within, value];
  // Array.from gives a hole as the undefined JSON would write as null.
  if (Array.isArray(value))
    return Array.from(value, (held: unknown, index) => copied(held, `${path}[${index}]`, what, inside));
  // An undefined property is one not given, which JSON leaves out. Built from entries, so a key such as __proto__
  // stays an own key.
  const entries = Object.entries(value).filter(([, held]) => held !== undefined);
  return Object.fromEntries(
    entries.map(([key, held]) => [key, copied(held, path ? `${path}.${key}` : key, what, inside)]),
  );
}

// The value as a load would give it back: plain objects, lists, strings, booleans, finite numbers and null, at every
// depth. It throws on anything else, naming the save (`what`) and the path to the value refused. The copy is what a
// save writes: a getter read again, or a toJSON, could otherwise give the write a value the check never saw.
export const checked = (value: unknown, what: string): JsonValue => copied(value, '', what, []);

// The text a save writes. The only call that turns saved data into JSON (docs/research/configured-name-collections.md,
// open question 5).
export function text<Value>(value: Value & JsonChecked<Value>, what: string, space?: number): string {
  return JSON.stringify(checked(value, what), null, space);
}
