// How an Event's shape is declared and checked, for lib/events.ts, which alone imports this: each Event's fields in
// their saved key order, each required or optional. The validation reads the declaration at runtime and the Event's
// type is derived from it, so a field added to one reaches both. A required field must be given, though it may be
// null; an optional one not given is saved as null.
import * as contract from './harnesses/contract.ts';

export type Presence = 'required' | 'optional';
export type Declaration<Fields> = { readonly [Field in keyof Fields]-?: Presence };
export type RequiredOf<Fields, Shape> = {
  [
    Field in keyof Fields as Field extends keyof Shape ? (Shape[Field] extends 'required' ? Field : never) : never
  ]: Fields[Field];
};
export type OptionalOf<Fields, Shape> = {
  [Field in keyof Fields as Field extends keyof Shape ? (Shape[Field] extends 'optional' ? Field : never) : never]:
    Fields[Field] | null;
};
export type Declared<Fields, Shape> = RequiredOf<Fields, Shape> & OptionalOf<Fields, Shape>;
export type DeclaredShape = Readonly<Record<string, Presence>>;
export type Fields = Record<string, unknown>;

export const declaredAs = (shape: DeclaredShape, presence: Presence): string[] =>
  Object.keys(shape).filter((field) => shape[field] === presence);

export function closed(what: string, fields: Fields, required: string[], optional: string[] = []): void {
  // An undefined value would vanish in JSON, so it counts as missing; null is a declared absence and stays.
  for (const key of required)
    if (!Object.hasOwn(fields, key) || fields[key] === undefined)
      throw new Error(`${what}: missing required field ${key}`);
  const known = new Set([...required, ...optional]);
  for (const key of Object.keys(fields)) if (!known.has(key)) throw new Error(`${what}: unknown field ${key}`);
}

// The two halves of an Event's body, each in its declared order, an optional field null when not given. These are
// the only assertions on the way to a saved Event: tsc gives a loop over names no type, and `closed` has checked the
// names. What the builders make of the halves, tsc checks.
export const requiredOf = <Of, Shape extends DeclaredShape>(shape: Shape, fields: Fields): RequiredOf<Of, Shape> =>
  Object.fromEntries(declaredAs(shape, 'required').map((key) => [key, fields[key]])) as RequiredOf<Of, Shape>;
export const optionalOf = <Of, Shape extends DeclaredShape>(shape: Shape, fields: Fields): OptionalOf<Of, Shape> =>
  Object.fromEntries(declaredAs(shape, 'optional').map((key) => [key, fields[key] ?? null])) as OptionalOf<Of, Shape>;

// Where a figure came from: reported by the Harness, or priced by gg from its tokens (#135, J13).
const COST_BASES = new Set(['reported', 'priced']);

// A Usage member is closed (#23, Clarify Q2 B): every USAGE_FIELDS key, each a number or null, and an optional
// costBasis.
export function checkUsage(usage: unknown, member: string): void {
  const memberUsage = (usage as Record<string, unknown> | null | undefined)?.[member];
  if (memberUsage === null || typeof memberUsage !== 'object')
    throw new Error(`action event: usage.${member} must be a Usage object`);
  const { costBasis, ...counts } = memberUsage as Fields;
  closed(`action event: usage.${member}`, counts, contract.USAGE_FIELDS);
  for (const key of contract.USAGE_FIELDS)
    if (!(counts[key] === null || typeof counts[key] === 'number'))
      throw new Error(`action event: usage.${member}.${key} must be a number or null`);
  if (!(costBasis == null || COST_BASES.has(costBasis as string)))
    throw new Error(`action event: usage.${member}.costBasis must be reported, priced or null`);
}
