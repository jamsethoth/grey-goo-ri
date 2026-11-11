# Holding configured names: Maps, model objects or dictionaries

Research note, 2026-11-07, against the tree at 653112b (branch `174-name-maps`, issue #174). Sources were read on
2026-11-07; spec section numbers are those of the current tc39.es draft and may move.

## The question

gg holds every name the configuration gives (Vertex ids, Procedure, Agent and Flow names, Action ids, Claim tokens,
Outcomes, inputs, Layer file names) and looks collections up by it. A plain object inherits `Object.prototype`, so
`__proto__` was dropped on write and `toString` read back as a function. PR #308 made those collections bare `Map`s
inside typed shapes (`lib/model.ts`, `lib/record.ts`), and callers read `flow.ticket.vertices.get(id)`. The owner asked
whether "defined model objects" would serve better. This note settles, from primary sources, what each way of holding
such data guarantees, and recommends one for gg.

## Facts from primary sources

### Why a plain object collides

- A property read that finds no own property continues to the prototype: OrdinaryGet step 2.c, "Return ?
  parent.[[Get]](propertyKey, receiver)" (ECMA-262 §10.1.8.1,
  https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinaryget). So `({})['toString']`
  is a function.
- A write that finds no own property also walks up (OrdinarySetWithOwnDescriptor step 1.b), and if the inherited
  property is an accessor it calls the setter: "Perform ? Call(setter, receiver, « value »)" (§10.1.9.2,
  https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinarysetwithowndescriptor).
- `Object.prototype.__proto__` is that accessor. Its setter sets `[[Prototype]]` when the value is an Object or null
  and returns undefined otherwise; it never creates an own property. The section is marked Normative Optional and
  Legacy, but every engine ships it (§20.1.3.8,
  https://tc39.es/ecma262/multipage/fundamental-objects.html#sec-object.prototype.__proto__). Checked on Node 26.13:
  `obj['__proto__'] = {y: 1}` leaves `Object.keys(obj)` empty.
- In an object literal, a non-computed `__proto__: value` is a prototype setter, not a property (PropertyDefinitionEvaluation,
  §13.2.5.6, https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-runtime-semantics-propertydefinitionevaluation),
  and two of them are a Syntax Error (§13.2.5.1). A computed `["__proto__"]` or shorthand form creates an own property
  (MDN, https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/Object_initializer#prototype_setter).
- `Object.fromEntries` and `JSON.parse` define own data properties. The same §13.2.5.6 sets `isProtoSetter` to false
  "inside a Script being evaluated for ParseJSON", and InternalizeJSONProperty uses `CreateDataProperty` over
  `EnumerableOwnProperties` (§25.5.2.4, https://tc39.es/ecma262/multipage/structured-data.html#sec-internalizejsonproperty).
  MDN: "In JSON, "__proto__" is a normal property key"
  (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/parse). Checked:
  `JSON.parse('{"__proto__":{"x":1}}')` has an own `__proto__` and its prototype is still `Object.prototype`.
- Own-key order is not insertion order: array-index keys first in ascending numeric order, then strings in creation
  order, then symbols (OrdinaryOwnPropertyKeys §10.1.11.1,
  https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-ordinaryownpropertykeys). Checked:
  keys set as `2, b, 1` enumerate as `1, 2, b` on an object and `2, b, 1` on a Map.

### What a Map guarantees

- "A `Map` does not contain any keys by default. It only contains what is explicitly put into it", and it "is safe to
  use with user-provided keys" (MDN Objects vs. Maps,
  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Map#objects_vs._maps). The spec gives
  Map its own `[[MapData]]` List, searched with SameValue after key canonicalisation; `get` returns undefined when no
  entry matches (§24.1.3.6, https://tc39.es/ecma262/multipage/keyed-collections.html#sec-map.prototype.get); `set`
  appends when none matches (§24.1.3.11); access must be sublinear on average (§24.1).
- Iteration is insertion order: `forEach` and the Map iterator walk `[[MapData]]` by index, visit entries added during
  the walk and skip deleted ones (§24.1.3.5, §24.1.5.1).
- `wrongMap['bla'] = 'x'` sets an ordinary property that `has`, `get` and `delete` never see (MDN, same page, "Setting
  object properties"). TypeScript rejects it: `Map<string, T>` has no index signature.
- The type of a miss is honest: `get(key: K): V | undefined` (lib.es2015.collection.d.ts, shipped with TypeScript;
  `ReadonlyMap<K, V>` has the same `get` and no `set`).

### What TypeScript can and cannot enforce

- An index signature or `Record<string, T>` reads as `T`: the handbook's `myArray[1]` is `string`
  (https://www.typescriptlang.org/docs/handbook/2/objects.html#index-signatures). Issue #13778 asked for `undefined`
  there; mhegazy answered "this is a conscious decision" (https://github.com/microsoft/TypeScript/issues/13778).
- `noUncheckedIndexedAccess` (TypeScript 4.1, PR #39560) adds `undefined` to every index-signature read, including
  array reads inside bounds-checked loops, and "is not automatically enabled by the `strict` flag"
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-1.html#checked-indexed-accesses---nouncheckedindexedaccess,
  https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html). gg's `tsconfig.json` sets `strict` only.
- No TypeScript type says "no inherited keys". Types are structural (Google TS style guide, "Use structural types",
  https://google.github.io/styleguide/tsguide.html#use-structural-types); `{}` and `Object.create(null)` both satisfy
  `Record<string, T>`, and `({} as Record<string, T>)['toString']` type-checks as `T` while being a function. Nominal
  types remain an open suggestion since 2014 (https://github.com/microsoft/TypeScript/issues/202); a brand marks a
  string as checked, it does not change where the string is stored.

### JSON, structuredClone and spread

- `JSON.stringify` visits `EnumerableOwnProperties` (SerializeJSONObject §25.5.4.5 step 6) after calling a `toJSON`
  method if the value has one (SerializeJSONProperty §25.5.4.2 step 2,
  https://tc39.es/ecma262/multipage/structured-data.html#sec-serializejsonproperty). A Map has no own enumerable
  properties, so it serialises as `{}` with no error (MDN: "Map, Set, etc. will become "{}"",
  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify). Checked. The same
  holds for `{...map}`, which copies own enumerable properties and so yields `{}`.
- `structuredClone` keeps a Map as a Map: StructuredSerializeInternal step 16 serialises `[[MapData]]` with type "Map"
  (https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal). An ordinary object is
  serialised as its own properties (step 28.4.1, `HasOwnProperty`) and deserialised as "a new Object in targetRealm",
  so a null prototype, a class prototype or a Map subclass is lost; a function throws `DataCloneError`. Checked: the
  clone of `Object.create(null)` has `Object.prototype`; the clone of a Map with keys `__proto__` and `toString` is a
  Map with both.
- Object spread and `Object.assign` copy own enumerable properties into an ordinary object (MDN Object.assign), so they
  too drop a null prototype. Checked.

### Equality, printing and lint

- `assert.deepStrictEqual` compares `[[Prototype]]` with `===`, considers only own enumerable properties, and compares
  "Map keys and Set items ... unordered"
  (https://nodejs.org/api/assert.html#comparison-details_1). Checked: `Object.create(null)` against `{}` fails; two Maps
  with the same entries in different order pass; a Map against an object literal fails.
- `util.inspect` prints `Map(2) { '__proto__' => 1, 'toString' => 2 }` and `[Object: null prototype] { a: 1 }`
  (https://nodejs.org/api/util.html#utilinspectobject-options; the prefix is visible in the `util.parseArgs` example).
  A null-prototype object has no `toString`, so `` `${obj}` `` throws "Cannot convert object to primitive value"
  (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object#null-prototype_objects).
- ESLint `no-prototype-builtins` (recommended) exists because a client can send `{"hasOwnProperty": 1}` and crash a
  server that calls `obj.hasOwnProperty` (https://eslint.org/docs/latest/rules/no-prototype-builtins);
  `prefer-object-has-own` prefers `Object.hasOwn`, which works on null-prototype objects (ES2022,
  https://eslint.org/docs/latest/rules/prefer-object-has-own,
  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/hasOwn). No ESLint or
  typescript-eslint rule forces an own-key check before an index read;
  `@typescript-eslint/consistent-indexed-object-style` is "purely a stylistic rule" between `Record` and index
  signatures (https://typescript-eslint.io/rules/consistent-indexed-object-style/).

### What style guides and real codebases do

- Google TS style guide, "Indexable types": "Rather than using one of these, consider using the ES6 `Map` and `Set`
  types instead. JavaScript objects have surprising undesirable behaviors and the ES6 types more explicitly convey your
  intent"; `Record<Keys, V>` is for keys that "are statically known" (https://google.github.io/styleguide/tsguide.html#indexable-types).
  The same guide prefers interfaces over classes for structural types.
- The TypeScript compiler moved its string-keyed symbol tables from `Object.create(null)` dictionaries to native `Map`
  in January 2017 (PR #12715, "Use native maps when they're available", 5% less time and memory; a reviewer noted that
  modifying `Object.prototype` could break `{}`-based maps, https://github.com/microsoft/TypeScript/pull/12715). Its
  coding guidelines say "do not use classes in the core compiler pipeline. Use function closures instead"
  (https://github.com/microsoft/TypeScript/wiki/Coding-guidelines).
- Node core's primordials guide: for an object whose own properties are defined from input, "always use a
  null-prototype object to avoid prototype pollution" (https://github.com/nodejs/node/blob/main/doc/contributing/primordials.md).
  Node's `util.parseArgs` returns one. Node, unlike gg, cannot assume `Map.prototype` is intact.

## Comparison

"Guarantee" names who keeps the invariant: the runtime (cannot be broken by a caller), the type system (a build error),
or discipline (every site must remember).

| Candidate | Collision safety | Miss typed as | JSON | structuredClone | deepStrictEqual | Order | Reading it |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1. Bare `Map` in typed shapes (current) | runtime | `T \| undefined` | `{}` unless converted at the boundary; silent | kept | structural, unordered | insertion | `.get(id)` plus `!` where presence is already proven |
| 2. Model classes or closures with accessors | inherited from the storage inside; the accessor adds the "present or crash" invariant | whatever the accessor declares | `toJSON` on the class makes stringify work | class prototype dropped, becomes a plain object; Map fields kept | prototypes must match, so fixtures build the class | as the storage | `flow.vertex(id)`; one type per collection |
| 3. `Object.create(null)` | runtime, until the first spread, `fromEntries`, `JSON.parse` or clone returns an ordinary object | `T` (or `T \| undefined` with the flag) | native | prototype dropped | fails against `{}` literals | integer keys first | prints `[Object: null prototype]`; `${obj}` throws |
| 4. `Record<string, T>` with own-key discipline | discipline; a `__proto__` write still hits the setter | `T` (or `T \| undefined` with the flag) | native | kept as object | passes | integer keys first | `Object.hasOwn` before every read; no lint enforces it |
| 5. Arrays of `{id, ...}` with an index | the index is a Map, so as 1 | `T \| undefined` | native (array) | kept | ordered compare | explicit | breaks the key-by-key Layer merge; two shapes to keep aligned |
| 6. Brands, `ReadonlyMap`, `Map` subclass | brand: none (compile-time mark on the string); `ReadonlyMap`: as 1 plus no `set`; subclass: as 1 | as 1 | subclass `{}` unless `toJSON` | subclass deserialises as a plain Map | subclass prototype must match | insertion | `ReadonlyMap` is a type change only |

Candidates 3 and 4 cannot be guaranteed by anything the type system sees: the invariant lives in a prototype or in a
habit, and every platform conversion resets it. Candidate 5 is candidate 1 with a second shape. Candidate 2 is not a
storage choice; it is an interface over candidate 1 (or 3), and buys an invariant only where one exists to encode.

## Recommendation for gg

Keep bare `Map`s as the storage. The runtime guarantees the invariant; the type system reports a miss as
`T | undefined` without `noUncheckedIndexedAccess`; `structuredClone` (which `visit-runner.ts` uses on the
Configuration Snapshot) keeps them; the TypeScript compiler and the Google guide reached the same place for the same
keys. Defined model objects would not make the data safer, and classes would cost gg two things it already relies on:
`structuredClone` of anything holding one, which drops its prototype, and `deepStrictEqual` against plain fixtures.
gg's convention is modules as namespaces with functions over plain data (`lib/paths.ts`, `lib/flow.ts`), as the TS
compiler's own guideline is.

Where an accessor earns its place is narrow and real: the nine `.get(x)!` sites (`visit-runner.ts` three, `visit-scope.ts`
three, `check-action.ts` two, `effect-actions.ts` one) each assert "the validator admitted this name, or the record
names an Action the Procedure declares". A `!` turns a broken invariant into a `TypeError` far from its cause. One
function per owner states the invariant and fails with the name: `model.vertex(flow, id)` and
`model.procedure(flow, name)` in `lib/model.ts`, and the Action-id reads of `visitState.runs` and `checks` beside their
type, each throwing gg's existing corrupt-record or crash error. That is the "model object" the owner asked about,
without a class. The counts (`visits`, `traversals`) and the bounded reads (`edge`'s `?? 0`, `reconcile`'s `has`) stay
bare: `T | undefined` is their true shape.

Type the Resolved Flow's collections `ReadonlyMap` (`lib/model.ts`): the validator and `fromJson` are its only
producers, `new Map(...)` is assignable to it, and the compiler then refuses a `set` on a Flow after admission. The
record's Maps stay `Map`: the interpreter writes them.

The JSON boundary stays where it is and stays explicit: `model.fromJson` and `model.toJson` for the Flow;
`record.toJson` and `record.fromJson` for the record (`lib/record-json.ts`, #330, which replaced `saveRecord`'s
replacer), each reading through `Object.entries` and writing through `Object.fromEntries`, which only ever see own keys.
The hazard to design against is silence: a Map that reaches `JSON.stringify` or an object spread anywhere else becomes
`{}` with no error. So no Map should sit in a shape that any module other than its owner stringifies (events, comments,
public text); the record's conversion is a guard, not a licence. A test per owner should hold this: a record with
`visits` and `traversals` keyed `__proto__` and `toString` saved and read back equal (`test/unit/record.test.ts`), and
the model round-trip to the same Config Hash (`test/unit/model.test.ts`, present). A grep in `test/unit/layout.test.ts`
or an ESLint restriction on `JSON.stringify` outside `record.ts`, `model.ts`, `config.ts` and `events.ts` would make the
boundary mechanical; the open question below asks whether an existing rule does it.

Tests should compare Maps with `deepStrictEqual` against `new Map([...])`, never against an object literal (the
prototype differs, so it always fails) and never after converting to an object (which hides an integer-key reorder).
Golden JSON compares after `toJson`. `test/support/named-flow.ts` already renames a whole Flow to `Object.prototype`
names; one case per owner (model, record, interpreter, reconcile, doctor) over that fixture is the regression net for
the invariant, and those cases exist on this branch.

Rejected for gg, with the deciding fact: `Object.create(null)` (every spread, `fromEntries`, `JSON.parse` and clone
returns an ordinary object, so the invariant is neither checkable nor preserved); own-key discipline (a `__proto__`
write still reaches the setter, and no lint enforces the read guard); arrays with ids (the Layer merge is key by key);
a `Map` subclass (`structuredClone` deserialises it as a plain Map and `deepStrictEqual` sees the prototype); brands
(they type the string, not the store).

## Open questions

1. Integer-like names. `#269` forbids `:`, `.`, `/`, `--` and whitespace in a name but not digits, so a Vertex named
   `1` sits first in `toJson`'s object and in `gg doctor` if doctor iterates the JSON, but in insertion order in the
   model. The Config Hash is taken over JSON, so it is stable; whether any output's order changed between the model and
   the JSON it used to iterate is worth one case. Decided 2026-11-08 (owner): integer-like names stay allowed and the
   model's declaration order stands wherever an output iterates it (the provenance table, the passed Checks a Terminal
   Reason lists); the JSON form keeps the language's order, and nothing compares the two.
2. Is there a lint that flags a Map reaching `JSON.stringify` or an object spread? typescript-eslint's
   `no-misused-spread` may cover the spread case; it was not verified here. Otherwise the boundary is held by the tests
   above and by `test/unit/layout.test.ts`'s grep. Answered 2026-11-09 (#327): `no-misused-spread` covers the spread,
   no shipped rule covers `JSON.stringify`, so gg's own type-aware `gg/no-map-to-json` does, and the grep is gone.
3. Should `visitState.runs` and `checks`, keyed by Action id, move beside `model.ts`'s accessors or keep their type in
   `lib/visit.ts` with the accessor in `lib/visit-scope.ts`, its reader? AGENTS.md's "a type lives in the module that
   owns its concept" argues for the latter.
4. `ReadonlyMap` on the Resolved Flow is a type-only change; whether the churn in `test/support/named-flow.ts` (which
   rebuilds Maps) is worth it depends on how often a test mutates a Flow after `fromJson`.
5. Should `gg/no-map-to-json` also fail a value typed `unknown`, `any` or `object`, which can hide a Map from any rule
   that reads types? Decided 2026-11-11 (owner, #330, option D). The rule's `unknown` option fails such an argument in
   `lib/`, `bin/` and `scripts/`, and also a union with such a member.
   - Measured on ada8948: **29** such arguments outside `test/` (28 in `lib/`, 1 in `scripts/`) and 8 in `test/`.
   - 26 quoted a configuration or response value in a message. They now go through `lib/quote.ts`, the one file
     exempt.
   - The 3 that carry gg data got types: the Pinned Configuration, `hashOf`'s sorted value and the coverage baseline.
   - `test/` keeps the Map check only.
   - The rule reads the value passed, not an `unknown` held inside a typed value. With that nested check, the count
     was 114, 79 of them in `test/`. The Execution Record's 19 such fields are #342's.
