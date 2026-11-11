// The JSON gg saves: its type, and the one function every save path serializes through (#342). tsc refuses a value
// whose type could hold what JSON cannot, and the same call refuses such a value at run time, naming the path to it.

// A value JSON.parse gives: what configuration, a Structured Response and a Harness's output are.
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// Whether two types are the same type, which assignability cannot say: `any` is assignable both ways to anything.
type Same<Left, Right> =
  (<Probe>() => Probe extends Left ? 1 : 2) extends <Probe>() => Probe extends Right ? 1 : 2 ? true : false;

type Scalar = string | number | boolean | null | undefined;

// What stands where a type could hold what JSON cannot. No saved value is assignable to it, and unlike `never` it
// does not vanish from a union, so an alternative refused stays to be seen.
declare const notJson: unique symbol;
interface NotJson {
  readonly [notJson]: true;
}

// One alternative of a type as a save takes it: itself where JSON holds it, with NotJson at each place that could
// hold what JSON cannot. `any` is assignable to anything but `never`, and an optional property's `never` reads
// `undefined`, so a property typed `any` or `unknown` is required as `never`.
type Walked<Value> = Value extends Scalar
  ? Value
  : Value extends object
    ? Value extends ReadonlyMap<unknown, unknown> | ReadonlySet<unknown> | ((...parameters: never[]) => unknown)
      ? NotJson
      : { [Key in keyof Value]: JsonChecked<Value[Key]> } & {
          [Key in keyof Value as unknown extends Value[Key] ? Key : never]-?: never;
        }
    : NotJson;

// The alternatives of a type that JSON cannot hold, each as walked. Each is judged against its own walk, never
// against the whole type's: beside JsonValue, `{ value: any }` is assignable to JsonValue's own object.
type Refused<Value> = Value extends unknown ? ([Value] extends [Walked<Value>] ? never : Walked<Value>) : never;

// A type as a save takes it: itself when JSON holds every value of it. Otherwise it is what `Refused` gives, beside
// its scalars, so no value of the type is assignable to it and tsc names the place that could hold what JSON cannot:
// a Map, a Set, a function, a symbol, a bigint, or an `unknown` or `any`, which hide any of them.
// - It reads an interface property by property, which a plain JsonValue parameter cannot: an interface has no index
//   signature (type-fest's Jsonify pattern, whose own mapping lets `unknown` through).
// - JsonValue itself is taken whole, which ends the walk of its own recursion. Only the same type is: `JsonValue | Map`
//   and `{ value: any }` are each assignable from it or to it.
// - An `undefined` is left to the run-time check, which knows a property not given from a list's lost element. So is
//   a class instance whose type is only its data: a type cannot tell it from a plain object.
export type JsonChecked<Value> = unknown extends Value
  ? never
  : Same<Value, JsonValue> extends true
    ? Value
    : [Refused<Value>] extends [never]
      ? Value
      : Refused<Value> | Extract<Value, Scalar>;

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

// A key JSON leaves out without a word: a symbol key, and a list's property that is not one of its elements.
const leftOut = (value: object): boolean =>
  Object.getOwnPropertySymbols(value).some((key) => Object.prototype.propertyIsEnumerable.call(value, key)) ||
  (Array.isArray(value) && Object.keys(value).length > value.length);

// The value copied as JSON.stringify would read it, each property read once: a list by index up to its length, an
// object by its own enumerable string keys. `within` holds the objects the value is inside.
function copied(value: unknown, path: string, what: string, within: object[]): JsonValue {
  const refuse = (problem: string): never => {
    throw new Error(`${what}: ${path || 'the value'} ${problem}`);
  };
  const kind = lost(value);
  if (kind) refuse(`is ${kind}, which JSON cannot hold`);
  if (value === null || typeof value !== 'object') return value as JsonValue;
  if (within.includes(value)) refuse('holds itself, which JSON cannot hold');
  if (leftOut(value)) refuse('has a key JSON leaves out');
  const inside = [...within, value];
  if (Array.isArray(value)) {
    // Never through its iterator, which may give other elements. A hole reads as the undefined JSON writes as null.
    const items: JsonValue[] = [];
    const { length } = value;
    for (let index = 0; index < length; index++) items.push(copied(value[index], `${path}[${index}]`, what, inside));
    return items;
  }
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
export function text<Value>(value: Value & NoInfer<JsonChecked<Value>>, what: string, space?: number): string {
  return JSON.stringify(checked(value, what), null, space);
}
