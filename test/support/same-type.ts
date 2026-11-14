import type * as jsonValue from '../../lib/json-value.ts';

// Whether two types hold the same keys at every depth, each with the same type (#402): tsc's identity check after both
// are normalized. A field that accepts any JSON is compared whole. An intersection is flattened, and an optional key
// typed only undefined or never is dropped, since it only rules a key out of a union's form (record.DecidedBy).
type Normal<Type> = [jsonValue.JsonValue] extends [Type]
  ? Type
  : Type extends readonly (infer Item)[]
    ? Normal<Item>[]
    : Type extends object
      ? { [Key in keyof Type as [Exclude<Type[Key], undefined>] extends [never] ? never : Key]: Normal<Type[Key]> }
      : Type;
export type Same<First, Second> =
  (<Probe>() => Probe extends Normal<First> ? 1 : 2) extends <Probe>() => Probe extends Normal<Second> ? 1 : 2
    ? true
    : false;

// `Type` with a key added to every object at `Path`: `[]` goes into a list's items, `*` into a keyed object's values,
// and a key into that key's value, in every form of a union that holds it.
export type KeyAddedAt<Type, Path extends string[]> = Path extends [infer Head, ...infer Tail extends string[]]
  ? Type extends readonly (infer Item)[]
    ? Head extends '[]'
      ? KeyAddedAt<Item, Tail>[]
      : Type
    : Type extends object
      ? {
          [Key in keyof Type]: Head extends '*'
            ? KeyAddedAt<Type[Key], Tail>
            : Key extends Head
              ? KeyAddedAt<Type[Key], Tail>
              : Type[Key];
        }
      : Type
  : Type extends readonly unknown[]
    ? Type
    : Type extends object
      ? Type & { undeclared: number }
      : Type;
