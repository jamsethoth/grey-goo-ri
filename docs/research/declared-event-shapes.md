# Event shapes declared once: the table, the derived type and the assertion

Research note, 2026-11-11, against the tree at 9c5ca3f (branch `342-save-path-gate`, issue #342, PR #347). Sources were
read on 2026-11-11. "Checked" means run here with TypeScript 6.0.3 and typescript-eslint 8.72.1 from this tree's
`node_modules`, on reduced models and on a copy of the tree outside the repository; no file of the tree was changed.

## The question

`lib/events.ts` declares each Event shape once, as a run-time table of its fields in saved order, each `required` or
`optional` (`ACTION`, `AGENT`, `LIFECYCLE`), beside an interface that gives each field's value type. The Event types
are derived from the tables with mapped types (`Declared<Fields, Shape>`), and the run-time check (`closed`) and the
ordered build (`ordered`) read the same tables. The builders end in three type assertions on object literals: `as Event`
in `eventLog`, `as EventBody<ActionEvent>` in `actionEvent` and `as EventBody<LifecycleOf<Type>>` in `lifecycleEvent`.
Rows are read back with `JSON.parse(row.json) as Event` and no check. There are 8 shapes and 71 declared fields (25
Action, 16 agent, 30 across six Lifecycle Events).

The owner must choose for PR #347: keep the table and the casts (A); replace the generic builders with one hand-written
builder per shape (B); or keep the one declaration and confine or remove the assertion. This note settles, from primary
sources and from trials, what each choice lets tsc check, what stays a run-time check, and what TypeScript 6.0 cannot
do.

## Facts from primary sources

### What a type assertion is, and when the handbook uses one

- The handbook introduces assertions for one case: "Sometimes you will have information about the type of a value that
  TypeScript can't know about." It adds: "Because type assertions are removed at compile-time, there is no runtime
  checking associated with a type assertion. There won't be an exception or `null` generated if the type assertion is
  wrong." The only limit is that an assertion must "convert to a _more specific_ or _less specific_ version of a type"
  (https://www.typescriptlang.org/docs/handbook/2/everyday-types.html#type-assertions).
- On an object literal an assertion drops the check for missing fields. typescript-eslint, on `const x = { ... } as T`:
  "The type assertion in the latter case is either unnecessary or will probably hide an error. The compiler will warn
  for excess properties with this syntax, but not missing _required_ fields"
  (https://typescript-eslint.io/rules/consistent-type-assertions, option `objectLiteralTypeAssertions`). Checked:
  `{ type: 'run_end', run: 'r' } as Body<'run_end'>` compiles with `failureClass` missing; the same literal under a
  type annotation fails with TS2322.
- An annotated literal is checked both ways: "Object literals get special treatment and undergo _excess property
  checking_ when assigning them to other variables, or passing them as arguments"
  (https://www.typescriptlang.org/docs/handbook/2/objects.html#excess-property-checks). Checked on an annotated
  literal: a missing field, a wrong value type, `undefined` where the type is `string | null`, and an extra field each
  fail. A literal with its fields in another order passes: a type carries no field order.
- Soundness is not a goal of the language. The design goals list as non-goals: "Apply a sound or "provably correct"
  type system. Instead, strike a balance between correctness and productivity", and "Add or rely on run-time type
  information in programs, or emit different code based on the results of the type system. Instead, encourage
  programming patterns that do not require run-time metadata"
  (https://github.com/microsoft/TypeScript/wiki/TypeScript-Design-Goals). TypeScript's own documents therefore say
  nothing about run-time schemas; a table such as `ACTION` is the "pattern" the second non-goal leaves to the program.

### Type guards, assertion functions and `satisfies`

- Type guards (TypeScript 1.6): "A user-defined type guard functions is one with a return type annotation of the form
  `x is T`, where `x` is a declared parameter in the signature, and `T` is any type"
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-1-6.html#user-defined-type-guard-functions).
  The handbook's own example has an assertion in its body: `return (pet as Fish).swim !== undefined;`
  (https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates).
- Assertion functions (TypeScript 3.7) were added because without them "for slightly conservative code it often forced
  users to use type assertions". "`asserts val is string` ensures that after any call to `assertIsString`, any variable
  passed in will be known to be a `string`"
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-7.html#assertion-functions). The pull
  request defines them by the guard: "Effectively, `assertIsArrayOfStrings(x)` is just shorthand for
  `assert(isArrayOfStrings(x))`" (https://github.com/microsoft/TypeScript/pull/32695).
- The body of a guard is not checked against its predicate. The 5.5 release notes, where predicates began to be
  inferred: "Explicit type predicates continue to work exactly as before. TypeScript will not check whether it would
  infer the same type predicate. Explicit type predicates ("is") are no safer than a type assertion ("as")"
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-5.html#inferred-type-predicates). I found
  no sentence that says the same of `asserts` in the 3.7 notes or in PR #32695; it follows from the shorthand above.
  Checked: `function isBody(value: unknown): value is Body<'run_end'> { return true; }` and
  `function assertBody(value: unknown): asserts value is Body<'run_end'> {}` both compile.
- `satisfies` (TypeScript 4.9): "The new `satisfies` operator lets us validate that the type of an expression matches
  some type, without changing the resulting type of that expression"
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#the-satisfies-operator). It checks an
  expression tsc can already type. `events.ts` uses it where it applies, to tie each table to its interface.
- Deriving a type from a value is the handbook's own advice: "It's also possible to express types in terms of _values_
  that we already have" (https://www.typescriptlang.org/docs/handbook/2/types-from-types.html), and of mapped types,
  "When you don't want to repeat yourself, sometimes a type needs to be based on another type"
  (https://www.typescriptlang.org/docs/handbook/2/mapped-types.html).

### Why tsc cannot check an object built by a loop

- `Object.fromEntries` returns an index signature, never the keys it was given:
  `fromEntries<T = any>(entries: Iterable<readonly [PropertyKey, T]>): { [k: string]: T; };`, with a second overload
  that returns `any` (`lib.es2019.object.d.ts` in TypeScript 6.0.3;
  https://github.com/microsoft/TypeScript/blob/main/src/lib/es2019.object.d.ts). Checked:
  `const built: { run: string } = Object.fromEntries([['run', 'r']])` fails with TS2741, "Property 'run' is missing in
  type '{ [k: string]: string; }'".
- `Object.keys` returns `string[]` (`keys(o: object): string[];`, `lib.es5.d.ts`) by decision. Anders Hejlsberg: "an
  object can (and often does) have more properties at run-time than are statically known at compile time", so
  `(keyof T)[]` "makes sense only in the domain of type variables"
  (https://github.com/microsoft/TypeScript/pull/12253#issuecomment-263132208).
- So a build that walks field names gives tsc a `Record<string, unknown>`, and only an assertion, a guard or a literal
  turns that into a shape with known keys. Checked on a reduced model of `lifecycleEvent`: with the cast removed, the
  return fails with TS2322.

### Why tsc cannot check a result that depends on a generic `Type`

- The rule, in Ryan Cavanaugh's words: "The current logic is that all function return expressions must be assignable to
  the explicit return type annotation (if one exists), otherwise an error occurs", so in a branch that has tested the
  argument, "`obj.url` is a `URL`, and a `URL` isn't a `T extends Person ? string : URL`"
  (https://github.com/microsoft/TypeScript/issues/33912, open, "In Discussion"; its sibling
  https://github.com/microsoft/TypeScript/issues/33014 is open too).
- Narrowing of return types by control flow was announced and then withdrawn. The 5.8 beta post: "TypeScript 5.8 now
  supports a limited form of checking against conditional types in return statements"
  (https://devblogs.microsoft.com/typescript/announcing-typescript-5-8-beta/#checked-returns-for-conditional-and-indexed-access-types).
  The 5.8 RC post: "Since our beta release, we have had to pull back some work on how functions with conditional return
  types are checked. Based on some of the limitations and changes we wanted to make, we decided to iterate on the
  feature with the goal of shipping it in TypeScript 5.9"
  (https://devblogs.microsoft.com/typescript/announcing-typescript-5-8-rc/). The revert is PR #61136, merged
  2025-02-07: "the current design for return type narrowing doesn't work well with object types"
  (https://github.com/microsoft/TypeScript/pull/61136).
- It did not ship in 5.9 or 6.0. Daniel Rosenwasser on the 5.9 plan: "We're not planning on bringing that in for 5.9.
  We want to be more conservative about larger features that are more involved while so much of our attention is
  currently on the port" (https://github.com/microsoft/TypeScript/issues/61648#issuecomment-2851713498). The follow-up,
  PR #61359 "Bring back return type narrowing + fixes", was closed unmerged on 2025-12-08
  (https://github.com/microsoft/TypeScript/pull/61359). The 5.9 and 6.0 release notes have no section on it. What 5.8
  kept is narrower: "Each branch of the conditional is checked against the declared return type"
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-5-8.html#granular-checks-for-branches-in-return-expressions).
  Checked on 6.0.3: `function pick<Type extends 'a' | 'b'>(type: Type): Type extends 'a' ? number : Type extends 'b' ?
  string : never { if (type === 'a') return 1; return 'x'; }` fails with TS2322 on both returns.
- The correlated-union limit is the other half. Issue #30581 (jcalz): "For now the only workarounds are type assertions
  (which are not safe) or to walk the compiler manually through the different constituents of the union type via type
  guards (which is repetitive and brittle)". Ryan Cavanaugh's reply: "We'd need some entirely new concept here, since
  we can't tell the OP example apart from this one (which is a wholly correct error)", that one being `r1.f(r2.v)` over
  two values of the union (https://github.com/microsoft/TypeScript/issues/30581#issuecomment-476417974).

### The 4.6 technique: a map from kind to shape

- PR #47109 closed #30581: "The fixes enable most of the problems outlined in #30581 to be solved using an approach
  that involves "distributive object types" created using indexed access types applied to mapped types." The form is
  `type UnionRecord<K extends keyof RecordMap = keyof RecordMap> = { [P in K]: { kind: P, v: RecordMap[P], ... } }[K]`,
  used by a function generic in `K`: "The pattern of applying an indexed access type to a mapped type is effectively a
  device for distributing a type ... over a union", and "because everything is expressed in terms of the mapping in
  `RecordMap`, new kinds and data types can be added in a single place, nicely conforming to the DRY principle"
  (https://github.com/microsoft/TypeScript/pull/47109). The 4.6 release notes describe it under "Indexed Access
  Inference Improvements"
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-6.html#indexed-access-inference-improvements).
- Its stated limit: "we don't reason about higher-order function calls to that extent. So, the best we can do is what
  you've already suggested" (Hejlsberg, https://github.com/microsoft/TypeScript/issues/30581#issuecomment-1008338350).
  It correlates types that are written as lookups into one map. It gives no type to a loop.
- "Control Flow Analysis for Dependent Parameters", also 4.6, is a separate change (PR #47190): "In cases where
  TypeScript infers the type of a function from a signature like this, TypeScript can now narrow parameters that depend
  on each other", for a rest parameter typed as a union of tuples
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-6.html#control-flow-analysis-for-dependent-parameters).
  It needs one branch per kind, so it serves per-shape code, not a builder shared by six Lifecycle types.
- Checked, reduced model: with `BUILDERS: { [Type in EventType]: (given: GivenMap[Type]) => BodyMap[Type] }`, the
  generic call `BUILDERS[type](given)` returns `BodyMap[Type]` with no assertion, a builder that omits a field fails,
  and a value typed `EventOf<Type>` is assignable to the union `EventOf`.

### What a trial on a copy of this tree showed

The trial keeps the three tables, `closed`, and the order. It changes `lib/events.ts` only (17 lines out, 25 in, 391
lines; not formatted or linted under gg's configuration):

```ts
type RequiredOf<Fields, Shape> = { /* the 'required' half of today's Declared */ };
type OptionalOf<Fields, Shape> = { /* the 'optional' half, each `| null` */ };
type Declared<Fields, Shape> = RequiredOf<Fields, Shape> & OptionalOf<Fields, Shape>;
// The 4.6 form: called with the union of types, it gives the union of bodies.
type LifecycleBody<Type extends LifecycleType> = {
  [Each in Type]: { type: Each } & Declared<LifecycleFields[Each], (typeof LIFECYCLE)[Each]>;
}[Type];

// The two places a loop's result is given its type.
const requiredOf = <Of, Shape extends DeclaredShape>(shape: Shape, fields: Fields): RequiredOf<Of, Shape> =>
  Object.fromEntries(declaredAs(shape, 'required').map((key) => [key, fields[key]])) as RequiredOf<Of, Shape>;
const optionalOf = <Of, Shape extends DeclaredShape>(shape: Shape, fields: Fields): OptionalOf<Of, Shape> =>
  Object.fromEntries(declaredAs(shape, 'optional').map((key) => [key, fields[key] ?? null])) as OptionalOf<Of, Shape>;

// actionEvent, after its checks: no assertion.
const common = { type: 'action' as const, ...requiredOf<ActionFields, typeof ACTION>(ACTION, fields) };
const optional = optionalOf<ActionFields, typeof ACTION>(ACTION, fields);
return agent
  ? { ...common, agent: true, ...requiredOf<AgentFields, typeof AGENT>(AGENT, fields), ...optional }
  : { ...common, agent: false, ...optional };

// lifecycleEvent<Type>, returning LifecycleBody<Type>: no assertion.
return {
  type,
  ...requiredOf<LifecycleFields[Type], (typeof LIFECYCLE)[Type]>(LIFECYCLE[type], fields),
  ...optionalOf<LifecycleFields[Type], (typeof LIFECYCLE)[Type]>(LIFECYCLE[type], fields),
};

// eventLog: `const event: Event = { schemaVersion: 2, time, ...(type === 'action' ? ... : ...) };`, no assertion.
```

- The whole tree (`lib`, `bin`, `scripts`, `test`) type-checks with it, and `test/unit/events.test.ts` passes, 104 of
  104. No other test file was run.
- All three Event-level assertions go. Two remain, in `requiredOf` and `optionalOf`, each saying only "this loop gives
  the fields the shape declares with this presence".
- `eventLog`'s `as Event` goes only with the 4.6 form of `LifecycleBody`. With `{ type: Type } & Declared<...>` in its
  place, the annotated `const event: Event` fails with TS2322: in `eventLog` `type` has narrowed to the union of the
  six Lifecycle types, and only the distributive form gives a union of bodies for it.
- Eight mistakes were seeded one at a time. tsc reported seven: the agent branch without the agent fields; an Action
  without its optional fields; a Lifecycle Event without its optional fields; a Lifecycle Event typed by the agent
  table; an Event without `schemaVersion`; `agent: true` on the deterministic branch; a table passed that is not the one
  the type argument names. It did not report the eighth, inside a helper: `requiredOf` reading the fields declared
  `optional`. The same eight seeded in today's file, each in its own terms, give no error.
- A helper constrained as `shape: Shape & Declaration<Fields>` does not compile in the generic builder: tsc cannot show
  that `(typeof LIFECYCLE)[Type]` is a `Declaration<LifecycleFields[Type]>`, two lookups in two maps. The `satisfies`
  on each table is what ties a table to its interface, as it does today.
- An assertion-function form also compiles: build the object as `object`, then
  `assertBody(type, built): asserts built is Body<Type>`, its body comparing the built keys with the table's. By the
  5.5 note it is no safer than the helpers' `as`, and its body can check names and order only.

### What the lint rules say

- gg loads no typescript-eslint preset, and none of the three rules is on (`eslint.config.mjs` enables
  `no-misused-spread` and `gg/no-map-to-json` among the typed rules).
- `no-unsafe-type-assertion`: "This rule forbids using type assertions to narrow a type, as this bypasses TypeScript's
  type-checking", and "Instead of using type assertions to narrow a type, it's better to rely on type guards"
  (https://typescript-eslint.io/rules/no-unsafe-type-assertion). Its metadata in 8.72.1 names no preset. Checked on
  `lib/events.ts`: 9 reports today (the three builder literals, `JSON.parse(...) as Event` twice with
  `row.json as string` twice, two in `checkUsage`); 8 with the trial (the two helpers in place of the three literals).
  Across `lib`, `bin` and `scripts` it reports 296 in 62 files.
- `consistent-type-assertions` with `objectLiteralTypeAssertions: 'never'` "would prefer `const x: T = { ... };` to
  `const x = { ... } as T;`". Its other option, `assertionStyle: 'never'`, bans every assertion: "Some codebases like to
  go for an extra level of type safety, and ban assertions altogether via the `never` option"
  (https://typescript-eslint.io/rules/consistent-type-assertions). Checked with the object-literal option: 3 reports in
  `lib/events.ts` today, the three builders; none with the trial; 17 in 11 files across `lib`, `bin` and `scripts`.
- `no-unnecessary-type-assertion` "reports when a type assertion does not change the type of an expression"
  (https://typescript-eslint.io/rules/no-unnecessary-type-assertion). Checked: none in `lib/events.ts`, 24 across
  `lib`, `bin` and `scripts`.

### Schema libraries: one run-time declaration, the type derived

Each derives the static type from a run-time value, as `events.ts` does. Each is published as JavaScript with
declarations, so none needs a build step or non-erasable syntax in gg; Node "refuses to handle TypeScript files inside
folders under a `node_modules` path" (https://nodejs.org/api/typescript.html#type-stripping-in-dependencies), which
concerns a library only if it shipped `.ts`. Versions are those of each repository's manifest on 2026-11-11.

- Zod 4.6.7. "Zod infers a static type from your schema definitions. You can extract this type with the `z.infer<>`
  utility" (https://zod.dev/basics, "Inferring types"). "Zero external dependencies"; "Tiny: 2kb core bundle
  (gzipped)"; "Zod is tested against *TypeScript v5.5* and later"; "You must enable `strict` mode" (https://zod.dev/).
  Unknown fields: "By default, unrecognized keys are *stripped* from the parsed result"; `z.strictObject` "throws an
  error when unknown keys are found". Absent-as-null is `z.nullable(...).default(null)` (`defaultTuna.parse(undefined);
  // => "tuna"`). A field whose type is one of gg's interfaces needs its own schema or `z.custom<T>()`: "If you don't
  provide a validation function, Zod will allow any value. This can be dangerous!" (https://zod.dev/api). The API page
  does not state the key order of a parsed object; not verified in source.
- Valibot 1.5.0. "To infer it, you use the utility type `InferOutput`" (https://valibot.dev/guides/infer-types/).
  "Valibot has no dependencies"; "Small bundle size starting at less than 700 bytes"
  (https://valibot.dev/guides/introduction/); peer `typescript >=5`. `strictObject` "forbids unknown entries and
  returns an issue for the first unknown entry found" (https://valibot.dev/guides/objects/). `nullish(schema, null)`
  gives absent-as-null: "this default value is always used if the input is missing, `undefined` or `null`"
  (https://valibot.dev/guides/optionals/). Its source fills the output with `for (const key in this.entries)`, so the
  output follows the schema's order
  (https://github.com/fabian-hiller/valibot/blob/main/library/src/schemas/strictObject/strictObject.ts); the guides
  do not promise it.
- TypeBox 1.x. "TypeBox is a runtime type system that creates in-memory JSON Schema objects that infer as TypeScript
  types"; `type T = Type.Static<typeof T>`; validation is a second module, "The compiler is available via optional sub
  module import"; 1.x is for TypeScript "6.0 - 7.0+" and "ESM only" (https://github.com/sinclairzx81/typebox). JSON
  Schema has no field order; how `Parse` orders or defaults its output was not verified.
- ArkType 2.2.9. `type User = typeof User.infer`; "At runtime, we can pass `unknown` data to our type and get back
  either a validated `User` or an array of clear, customizable errors" (https://arktype.io/docs/intro/your-first-type).
  It can check against a type written elsewhere: "what if you need to define a Type matching a pre-existing external
  type? The `declare` API allows just that" (https://arktype.io/docs/declare). Undeclared keys are kept unless
  `"+": "reject"` (https://arktype.io/docs/objects). It needs "TypeScript version `>=5.1`" and ESM
  (https://arktype.io/docs/intro/setup), and depends on three packages of its own (`@ark/util`, `@ark/schema`,
  `arkregex`).
- io-ts 2.2.22. "we can validate the type at runtime, and we can also extract the corresponding static type, so we
  don’t have to define it twice"; "Static types can be extracted from codecs using the `TypeOf` operator"; `t.exact`
  strips, not rejects, additional properties (https://github.com/gcanti/io-ts/blob/master/index.md). "`fp-ts` is a peer
  dependency for `io-ts`" (https://github.com/gcanti/io-ts).
- Effect Schema (`effect` 4.1.4; the site's pages may describe an earlier major). "you can extract the inferred type
  `Type` in two ways: Using the `Schema.Type` utility ..."; one schema decodes and encodes; excess properties are
  removed unless `onExcessProperty: "error"`. On order: "By default, the `propertyOrder` option is set to `"none"`.
  This means that the internal system decides the order of keys to optimize parsing speed. The order of keys in this
  mode should not be considered stable"; the other setting keeps the input's order, not the schema's
  (https://effect.website/docs/schema/getting-started/). It needs "TypeScript 5.4 or newer" and `strict`
  (https://effect.website/docs/schema/introduction/), and the whole `effect` package.

Required-or-null and absent-saved-as-null can be said in each. A fixed saved order is promised by none of the pages
read: Effect disclaims it, Valibot has it in source only, the rest were not verified. gg would keep `ordered` or lean
on an implementation detail.

### Data read back from storage

- `JSON.parse` is declared `parse(text: string, reviver?: (this: any, key: string, value: any) => any): any;`
  (`lib.es5.d.ts`). An issue against that was closed "Working as Intended"; Ryan Cavanaugh endorsed this account of it:
  "you're going to want to cast the return of JSON.parse to a type specific for your application, probably using runtime
  checks and type guards along the way" (https://github.com/microsoft/TypeScript/issues/26993#issuecomment-419975922).
  `unknown` is "the type-safe counterpart of `any`": "no operations are permitted on an `unknown` without first
  asserting or narrowing to a more specific type"
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-0.html#new-unknown-top-type).
- The libraries parse; none of the pages read uses the phrase "parse, don't cast". The comments of Zod's first example
  read "some untrusted data..." and "the parsed result is validated and type safe!" (https://zod.dev/). Valibot: a
  schema "can also be executed at runtime to guarantee type safety of unknown data"
  (https://valibot.dev/guides/introduction/). io-ts: "You can use this runtime type to validate or decode untrusted
  data" (https://github.com/gcanti/io-ts/blob/master/index.md). Valibot ranks its own guards below parsing: with `is`
  or `assert`, "transformations have no effect and unknown keys of an object are not removed. Therefore, this approach
  is not as safe and powerful" (https://valibot.dev/guides/parse-data/).
- One declaration serves both directions in Zod ("All Zod schemas can process inputs in both the forward and backward
  direction", https://zod.dev/codecs), Effect Schema (decoding and encoding) and io-ts (`decode`, `encode`).
- gg's tables hold field names and presence, not value types: the interfaces are erased. A read-side check built on
  them can verify the header, the type and the field names, and nothing about a value. One production read exists
  today: `terminal-report.ts` reads `failureClass` from `executionEvents` to find a run stop. `lib/trace.ts` and
  `lib/stats.ts` are stubs.

### Hand-written constructors per variant

- The handbook pages read (Narrowing, Object Types, Everyday Types) give no guidance for or against a constructor
  function per member of a union. They recommend the union itself, "good for representing any sort of messaging scheme
  in JavaScript", over one loose shape, whose non-null assertions "are error-prone if we start to move code around"; and
  for consumers the `never` check: "Adding a new member to the `Shape` union, will cause a TypeScript error"
  (https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions, `#exhaustiveness-checking`).
- What a literal per shape guarantees follows from the checks above: every field present, of its type, `null` and never
  `undefined`, and no extra field, all at build time and with no assertion. It does not check order.
- What it loses is what the table gives at run time: `closed` refuses an unknown or missing field of a value tsc never
  saw (`eventLog` merges `base` with `data` into a `Record<string, unknown>`; `admission.ts` passes
  `data as events.EventInput<'label_failed'>`), and a reader can ask which fields a type declares.

### Where the brief was wrong or loose

- "tsc cannot ... narrow a generic `Type`" is not why the builders need casts. Only the loop needs one. The trial
  removed all three Event-level casts with `Type` still generic.
- #30581 was closed by PR #47109, the indexed-access change. "Control Flow Analysis for Dependent Parameters" is another
  pull request and does not apply to a shared generic builder.
- The conditional-return work was announced for 5.8, reverted before 5.8 shipped, and is in neither 5.9 nor 6.0.
- M1 as briefed, "one assertion function or type guard whose body is the existing run-time check", does not fit the
  write side as it stands: the builder makes a new object, so there is nothing to narrow, and the run-time check knows
  names, not value types. The trial's typed helpers are its nearest form.

## Comparison

"Places" counts where one field's name, presence and type are written. Value types are never checked at run time
except in M3. `jsonValue.text` checks in every row that JSON can hold the Event.

| Choice | What tsc checks where an Event is built | Checked at run time | Read side | Places | To add a field or an Event | New dependencies | Primary source behind it |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A. Table and casts (today) | Callers' field names and value types (`EventInput`); nothing inside the builders: three assertions on object literals, 0 of 8 seeded mistakes reported | Required and unknown names, order, null fill, from the table | None; could check names from the table | 2: interface, table (`satisfies` ties them) | Field: 2 lines. Event: interface entry, table entry, union member | None | Handbook: an assertion for what "TypeScript can't know"; against: typescript-eslint, a literal assertion "will probably hide an error" |
| B. A literal builder per shape | Everything but order, with no assertion, if the dispatch is also per shape | Only what each builder writes by hand; no table for `closed` unless kept | None; nothing to read at run time unless the table is kept | 2 without the table (type, builder), 3 with it | Field: 2 or 3 lines. Event: type, builder, union member, dispatch case; `never` check catches a missing case | None | Handbook: excess property checks, discriminated unions, exhaustiveness |
| M1. Table kept, the assertion moved to the loop (trial) | The composition of every Event: header, type, `agent`, which tables, both presences; 7 of 8 seeded mistakes reported. Not the two helper bodies | As A | As A | 2, as A | As A | None | 5.5 notes (a guard is "no safer than a type assertion", so the assertion stays and shrinks); `satisfies` (4.9); PR #47109 for `eventLog` |
| M2. 4.6 map of builders | As B; the generic dispatch `BUILDERS[type](given)` needs no assertion | As B | As B | As B | As B, and a builder missing from the map is an error | None | PR #47109 and the 4.6 notes; its limit, Hejlsberg: no reasoning about a loop or higher-order call |
| M3. A schema library for Events | Callers against the inferred type; the builder is `parse`, no assertion in gg | Names, presence and value types, for every field that has a schema; a `custom` field checks nothing | The same schema parses a row | 1, the schema; value types now in seven other modules move into schemas or are written twice | Field: 1 line. Event: a schema and a union member | 1 package (Zod, Valibot: no dependencies of their own; io-ts needs fp-ts; ArkType three packages; Effect the whole library) | Each library's inference and parse pages; none promises declared order, Effect disclaims it |

M2 is not a way to keep the loop: it types the choice of builder, and each builder is still a literal (B) or a loop
with an assertion (M1). Its one piece that helps a table is the distributive body type, which M1 uses.

## Recommendation for gg

Decided 2026-11-11 (owner, #342): M1. It landed in `lib/events.ts` as trialed, with the comments gg's conventions ask
for, and beside one more change the owner chose in the same batch: `eventLog` takes what it is given through the
save's typed gate (`lib/json-value.ts`) and refuses a key the Event does not declare, since every field of an Event's
input is optional and a record of unknown values would fit. The file is 400 lines, at the lint limit, so the next
Event or field means a split.

Take M1 as trialed: keep the three tables as the one declaration, split `Declared` into its two halves, give the two
loops their type in `requiredOf` and `optionalOf`, write `LifecycleBody` in the 4.6 form, and drop the three assertions
on Event literals.

The reasons, in order of weight:

1. The loop is the only thing tsc cannot follow, and TypeScript 6.0 has no feature that changes that:
   `Object.fromEntries` returns an index signature, and return-type narrowing was reverted and has not come back. Some
   assertion stays under every choice that keeps a table. The 5.5 notes say a guard or an assertion function would be
   the same assertion under another name, so the choice is where it sits and how little it claims.
2. Today's three assertions sit on whole Event literals, the form the typescript-eslint docs say "will probably hide an
   error", and on this tree they hide all eight seeded mistakes. Moved to the loop, the assertion claims only "the
   declared fields of this presence", tsc reports seven of the eight, and the eighth is what `events.test.ts` already
   covers: order and null fill.
3. B buys the same checks by writing 71 fields a second or third time in a file that gains fields often, and gives up
   the run-time table: the unknown-field check on values tsc never saw, and the names a reader could check. The file is
   383 lines against an ESLint limit of 400, so B also means a split. PR #47109's own argument for the map form is that
   a kind is "added in a single place".
4. M3 is the only choice that checks value types at run time, and nothing reads Events back yet beyond one field. It
   would cost a dependency, schemas for types that live in seven other modules, and `ordered` kept anyway, since no
   library promises declared order.

The read side stays as it is in #342, with its two `JSON.parse(...) as Event` named as the open risk. When `gg trace`
or `gg stats` is built, both reads should go through one function that parses to `unknown`, checks the header, the type
and the field names against the same tables, and only then returns an `Event`.

What would change this:

- To A: the owner judging that 42 changed lines are not worth seven compile-time checks that `events.test.ts` could
  also hold. A is defensible; it is what the handbook's assertion is for.
- To B: Event shapes ceasing to be flat lists, so that most builders carry their own logic as `actionEvent` does for
  `usage`; or the run-time `closed` check being dropped, which removes the table's second reader.
- To M3: a reader that must trust value types, which means `gg trace` or `gg stats` over rows written by another
  version of gg, or Events arriving from outside gg. Then a schema pays for itself on the read side, and Valibot or Zod
  are the two with no dependencies of their own.
- To no assertion at all: TypeScript shipping #33014 or #33912 would not do it; a typed `Object.fromEntries` over a
  `const` tuple of entries would, and `lib.es2019.object.d.ts` in 6.0.3 has none.

## Open questions

1. Rows written before a field was added. Every Event carries `schemaVersion: 2`, the file gains fields often, and a
   row saved before a field existed lacks it, while `as Event` types it `T | null`. Does such a row count as schema 2,
   and should a reader fill `null`? This decides how much a read-side check must do, and it was not investigated here.
2. Should gg turn on `consistent-type-assertions` with `objectLiteralTypeAssertions: 'never'`? It would hold the M1
   state mechanically. It reports 17 sites in 11 files across `lib`, `bin` and `scripts` today; the other 14 were not
   read.
3. One helper or two. `requiredOf` and `optionalOf` could be one function with the presence as an argument and an
   overload per presence. That is one assertion site, not two, at the cost of overloads tsc also does not check
   against the body. Not trialed.
4. Whether `closed` should be told the tables, not the name lists `declaredAs` gives. Today `actionEvent` builds its
   lists once at module load (`ACTION_REQUIRED` and the rest) and the trial's helpers call `declaredAs` again per
   Event. The cost was not measured.
5. The trial ran `test/unit/events.test.ts` only. The full suite, the format check and gg's lint were not run on it;
   `LifecycleBody`'s layout will change under Prettier, and the longer helper line is 118 columns of the 120 allowed.
