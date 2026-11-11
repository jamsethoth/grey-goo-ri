// The JSON gg saves: its type, and the one function every save path serializes through (#342). tsc refuses a value
// whose type could hold what JSON cannot, and the same call refuses such a value at run time, naming the path to it.

// A value JSON.parse gives: what configuration, a Structured Response and a Harness's output are.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// A type as a save takes it: itself where JSON holds every value of it, with `never` at each place that could hold
// what JSON cannot: a Map, a Set, a function, a symbol, a bigint or an `unknown`, which hides any of them. It reads an
// interface property by property, which a plain JsonValue parameter cannot: an interface has no index signature
// (type-fest's Jsonify pattern, whose own mapping lets `unknown` through). An `undefined` is left to the run-time
// check, which knows a property not given from a list's lost element.
export type JsonChecked<Value> = unknown extends Value
  ? never
  : Value extends JsonValue | undefined
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
  if (Array.isArray(value) || prototype === Object.prototype || prototype === null) return null;
  // JSON writes a Map, a Set or an Error as {}, and any other class instance as something a load does not give back.
  return named((value as { constructor?: { name?: string } }).constructor?.name || 'class instance');
}

function assertHeld(value: unknown, path: string, what: string): void {
  const kind = lost(value);
  if (kind) throw new Error(`${what}: ${path || 'the value'} is ${kind}, which JSON cannot hold`);
  if (Array.isArray(value)) {
    // By index, so a hole is read as the undefined JSON would write as null.
    for (let index = 0; index < value.length; index++) assertHeld(value[index], `${path}[${index}]`, what);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  // An undefined property is one not given, which JSON leaves out.
  for (const [key, held] of Object.entries(value))
    if (held !== undefined) assertHeld(held, path ? `${path}.${key}` : key, what);
}

// Throws unless a load gives the value back as it was saved: plain objects, lists, strings, booleans, finite numbers
// and null, at every depth. `what` names the save in the error, ahead of the path to the value refused.
export function assertJson(value: unknown, what: string): void {
  assertHeld(value, '', what);
}

// The text a save writes. The only call that turns saved data into JSON (docs/research/configured-name-collections.md,
// open question 5).
export function text<Value>(value: Value & JsonChecked<Value>, what: string, space?: number): string {
  assertJson(value, what);
  return JSON.stringify(value, null, space);
}
