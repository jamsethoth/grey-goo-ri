// Whether two types hold the same keys at every depth, each with the same type (#402). Stub: true for any pair.
export type Same<First, Second> = true;

// A key added to every object at `path` in `Type`: `[]` goes into a list's items, `*` into a keyed object's values.
// Stub: the type unchanged.
export type KeyAddedAt<Type, Path extends string[]> = Type;
