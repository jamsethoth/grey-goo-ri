# Typing a value that is exactly one of several object forms

Research note, 2026-11-11, against the tree at 9c5ca3f (branch `342-save-path-gate`, issue #342). Sources were read on
2026-11-11: the handbook and release notes from the files typescriptlang.org is built from
(microsoft/TypeScript-Website, branch `v2`), with each live page checked for the anchor cited; issue comments through
GitHub's public API; type-fest 5.10.0 and typescript-eslint's rule documents from their repositories. Every statement
about what tsc does was compiled with the repository's TypeScript 6.0.3 on Node 26.13.0 under the compiler options of
`tsconfig.json`; the probes and their output are at the end of the facts.

## The question

`terminalReason.decidedBy` records who decided an Execution's end state. gg builds exactly three forms of it:

- `{ hold: name }`, `name` a `string | null` (`lib/terminal.ts:34`, `lib/visit-runner.ts:154`);
- `{ human: label }` (`lib/terminal.ts:46`);
- `{ vertex, visit, action, recovery }`, `visit` a `number | null` and `action` a `string | null`
  (`lib/terminal.ts:91` and `:128`).

The value is saved in the Execution Record's row and in the `ticket_end` Event (`lib/events.ts:168`). No field of the
saved shape says which form it is. Before #342 the field was `Record<string, unknown>`; #342 typed it as one interface
whose six fields are all optional (`lib/record.ts:28`). One line in `lib/` reads it (`lib/admission.ts:193`, `.hold`),
six test lines read one member, and 29 test lines build or compare the whole object, three of them with `{}`.

The decision this note informs: how should a TypeScript value that is exactly one of several object forms, with no
discriminant property in its persisted JSON, be typed?

The forms compared, by the letters used below:

- **O**: one interface, every field optional (what the PR has).
- **U**: a plain union of the three forms.
- **X**: that union, each member also listing the other members' keys as optional `never`.
- **T**: X produced by a helper type, type-fest's or a hand-written one.
- **K**: a union with a `kind` discriminant added to the saved shape.

## Facts from primary sources

### What the handbook recommends for a value of several shapes

- The handbook's own first attempt at such a value is an interface with optional members, and it names that as the
  problem: "The problem with this encoding of `Shape` is that the type-checker doesn't have any way to know whether or
  not `radius` or `sideLength` are present based on the `kind` property. We need to communicate what _we_ know to the
  type checker." The work-around, a `!` on each read, is "error-prone if we start to move code around"
  (Narrowing, "Discriminated unions",
  https://www.typescriptlang.org/docs/handbook/2/narrowing.html#discriminated-unions). Its example is
  `interface Shape { kind: "circle" | "square"; radius?: number; sideLength?: number; }`.
- Its answer is a union of one interface per shape with a common literal property: "When every type in a union
  contains a common property with literal types, TypeScript considers that to be a _discriminated union_, and can
  narrow out the members of the union." It names messages as a use: "They're good for representing any sort of
  messaging scheme in JavaScript, like when sending messages over the network (client/server communication), or
  encoding mutations in a state management framework" (same section).
- For a union with no common property it documents the `in` operator: "The "true" branch narrows `x`'s types which
  have either an optional or required property `value`, and the "false" branch narrows to types which have an optional
  or missing property `value`", and "To reiterate, optional properties will exist in both sides for narrowing"
  (https://www.typescriptlang.org/docs/handbook/2/narrowing.html#the-in-operator-narrowing).
- Exhaustiveness: "The `never` type is assignable to every type; however, no type is assignable to `never` (except
  `never` itself). This means you can use narrowing and rely on `never` turning up to do exhaustive checking in a
  `switch` statement" (https://www.typescriptlang.org/docs/handbook/2/narrowing.html#exhaustiveness-checking).
- The handbook's objection is to members whose presence follows from nothing. Form O has that property and no `kind`
  either. Probed: under O a present `vertex` does not make `visit` present (O-r4, `number | null | undefined`), and
  after all three keys are tested the value is still `DecidedBy`, not `never` (O-r5).
- The handbook and the release notes nowhere show a hand-written union whose members list each other's keys as
  `?: never`. A search of the 104 English files under `release-notes`, `handbook-v2`, `reference`,
  `declaration-files`, `javascript` and `get-started` for `?: never` and `?: undefined` found two: the 2.7 note quoted
  under "The optional `never` form" below, and a deprecated `decorators?: undefined` in the 4.8 note.

### What tsc allows on a union with no discriminant (U)

- A member cannot be read before narrowing. `decidedBy.hold` is error TS2339, "Property 'hold' does not exist on type
  'DecidedBy'. Property 'hold' does not exist on type 'Human'" (U-r1, U-r3). Optional chaining and a comparison with a
  literal change nothing: the lib reader's expression,
  `executionRecord?.terminalReason?.decidedBy?.hold === 'interrupted-attempt'`, is the same error (U-r2).
- `in` narrows. TypeScript 2.7, "Type guards inferred from `in` operator": "For a `n in x` expression, where `n` is a
  string literal or string literal type and `x` is a union type, the "true" branch narrows to types which have an
  optional or required property `n`, and the "false" branch narrows to types which have an optional or missing
  property `n`" (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-7.html#type-guards-inferred-from-in-operator).
  Probed: `'hold' in decidedBy && decidedBy.hold === 'interrupted-attempt'` compiles, and three `in` tests leave
  `never` (U-r4, U-r6, U-r5).
- TypeScript 4.9, "Unlisted Property Narrowing with the `in` Operator", covers the other case, a property no member
  lists: "Instead of leaving them as-is, the language will intersect their types with
  `Record<"property-key-being-checked", unknown>`"
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-9.html#unlisted-property-narrowing-with-the-in-operator).
  It does not bear on reading a member one of the forms lists.
- A literal that mixes members compiles. Probed: `{ hold: 'a', human: 'b' }` and a Hold with all four Action keys are
  accepted as `DecidedBy`, as a literal and from a variable (U-b5, U-b6, U-b9). TypeScript 3.5, "Improved excess
  property checks in union types": "Previously, a non-discriminated union wouldn't have _any_ excess property checking
  done on its members", and since then "the type-checker at least verifies that all the provided properties belong to
  _some_ union member and have the appropriate type ... Note that partial overlap is still permitted as long as the
  property types are valid"
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-5.html#improved-excess-property-checks-in-union-types).
  Probed: only a mix with a wrong type is refused (U-b10).
- The team states this as the standing behaviour. Issue #20863, "Unions without discriminant properties do not perform
  excess property checking", is open and labelled Suggestion, Needs Proposal. sandersn (member): "Excess property
  checking of unions does not work because all it does is try to find a single member of the union to check for excess
  properties. It does this based on discriminant properties, but `A` doesn't have any overlapping properties, so it
  can't possibly have any discriminant properties. ... So excess property checking is just skipped"
  (https://github.com/microsoft/TypeScript/issues/20863#issuecomment-354894849). RyanCavanaugh (member), 2019: "it
  seems like the scenario in the OP isn't something we could feasibly touch at this point - it's been the behavior of
  EPC for unions since either of those features existed, and people write quasioverlapping unions fairly often"
  (https://github.com/microsoft/TypeScript/issues/20863#issuecomment-540838200). And in 2025: "Excess properties are
  allowed when they appear elsewhere in a union, because when we implemented excess property checking, we found that a
  huge number of type definitions were extremely sloppy about when it was actually a disjoint union vs just an optional
  property" (https://github.com/microsoft/TypeScript/issues/14094#issuecomment-2616364872).
- `{}` and a partial Action identity are refused, since neither is assignable to any member (U-b7, U-b8).

### The optional `never` form (X)

- What tsc was observed to do with it:
  - a member is read with no narrowing: `decidedBy.hold` is `string | null | undefined` and `decidedBy.visit` is
    `number | null | undefined` (X-r1, X-r3), and the lib reader's expression compiles unchanged (X-r2);
  - a comparison narrows the union: after `decidedBy.hold === 'interrupted-attempt'` or `decidedBy.hold === null` the
    value is a `Hold`, and after `decidedBy.vertex !== undefined` its `visit` is `number | null` (X-r6, X-r7, X-r4);
  - three `!== undefined` tests leave `never` (X-r5);
  - `{ hold: 'a', human: 'b' }` is refused, "Types of property 'human' are incompatible. Type 'string' is not
    assignable to type 'undefined'", and so is a Hold with the Action keys (X-b5, X-b6);
  - the refusal is by assignability, not by the excess property check, so the same mix from a variable is refused
    too (X-b9); U and K both accept it (U-b9, K-b9);
  - `{}` and a partial Action identity are refused (X-b7, X-b8).
- Why a comparison narrows: every key is now a property common to all members, and TypeScript 3.2, "Non-unit types as
  union discriminants", made such a property a discriminant: "Common properties of unions are now considered
  discriminants as long as they contain _some_ singleton type (e.g. a string literal, `null`, or `undefined`), and they
  contain no generics"
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-3-2.html#non-unit-types-as-union-discriminants).
- It is the type the compiler itself infers for a value built as one of several literals. TypeScript 2.7, "Improved
  type inference for object literals": "When multiple object literal types contribute to a union type, we now
  _normalize_ the object literal types such that all properties are present in each constituent of the union type",
  with the example `const obj = test ? { text: "hello" } : {}; // { text: string } | { text?: undefined }`
  (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-2-7.html#improved-type-inference-for-object-literals).
  Probed on 6.0.3: a conditional over gg's three literals is inferred as form X,
  `{ hold: string | null; human?: undefined; vertex?: undefined; ... } | { human: string; hold?: undefined; ... } | ...`
  (probe-inferred prints it whole). Without `exactOptionalPropertyTypes`, tsc prints a `?: never` member as
  `?: undefined`: they are the same type.
- What the team has said of it, in issues only:
  - #14094, "Proposal: Add an "exclusive or" (^) operator", is closed and labelled Declined. RyanCavanaugh (member)
    gave the meaning the operator would have had: "Presumably the behavior here would be that
    `type A = { m: T } ^ { n : U };` is equivalent to `type A = { m: T, n: undefined } | { m: undefined, n : U };`"
    (https://github.com/microsoft/TypeScript/issues/14094#issuecomment-285783297). After a commenter posted the
    `Without`/`XOR` helper built on `?: never`
    (https://github.com/microsoft/TypeScript/issues/14094#issuecomment-373782604), he wrote: "The offered types above
    seem like good fits for what we would have implemented anyway, and it doesn't seem like we really need sugar for
    them" (https://github.com/microsoft/TypeScript/issues/14094#issuecomment-428279122).
  - #20863: after commenters posted `StrictUnion`, which intersects each member with
    `Partial<Record<Exclude<UnionKeys<TAll>, keyof T>, never>>`
    (https://github.com/microsoft/TypeScript/issues/20863#issuecomment-479471546), RyanCavanaugh wrote: "The solutions
    described above are all pretty good and honestly much more expressive than just the originally-proposed behavior
    change, so I'd recommend choosing one of those based on what you want to happen. Overall Exact/Closed types seem
    like the real underlying request for most of these scenarios, so follow #12936 for next steps there"
    (https://github.com/microsoft/TypeScript/issues/20863#issuecomment-540838200).
  - #12936, "Exact Types", is open and labelled Suggestion, Awaiting More Feedback; the language has no exact or
    "one of" type today.
- Its limits, each probed:
  - `in` no longer narrows, because every member lists every key as optional (the handbook sentence on optional
    properties above): inside `'hold' in decidedBy` the read is still `string | null | undefined` (X-r8). On a value
    read from JSON the two tests agree at run time, since JSON holds no `undefined`.
  - `== null` does not tell a missing `hold` from a Hold whose name is `null`, and tsc does not narrow on it (X-r9).
    ESLint's `eqeqeq` in gg allows `== null`.
  - `{ human: 'x', hold: undefined }` compiles (X-b10): `exactOptionalPropertyTypes` would refuse it, and that flag
    "is **not** part of the `strict` family and needs to be turned on explicitly"
    (https://www.typescriptlang.org/docs/handbook/release-notes/typescript-4-4.html#exact-optional-property-types---exactoptionalpropertytypes).
    gg's save gate writes no key for it: "An undefined property is one not given, which JSON leaves out"
    (`lib/json-value.ts` at 9c5ca3f).
  - a fourth form must add its keys to the other three by hand, or be written through a helper (T).

### type-fest's exclusive-key helpers (T)

- `MergeExclusive<FirstType, SecondType>`: "Create a type that has mutually exclusive keys."; "Use {@link
  ExclusifyUnion} to make more than two types mutually exclusive."; "This type was inspired by [this
  comment](https://github.com/Microsoft/TypeScript/issues/14094#issuecomment-373782604)." Its source is that comment's
  helper, with index signatures and key aliases handled
  (https://github.com/sindresorhus/type-fest/blob/main/source/merge-exclusive.d.ts):

  ```ts
  type Without<FirstType, SecondType> = {[KeyType in FirstType extends unknown ? Exclude<keyof OmitIndexSignature<FirstType>, KeysWithAliases<SecondType>> : never]?: never};
  export type MergeExclusive<FirstType, SecondType> =
  	(FirstType | SecondType) extends object
  		? (Without<FirstType, SecondType> & SecondType) | (Without<SecondType, FirstType> & FirstType)
  		: FirstType | SecondType;
  ```

- `ExclusifyUnion<Union>`: "Ensure mutual exclusivity in object unions by adding other members’ keys as `?: never`."
  Its listed use-cases include "You want to safely access any property defined across the union without additional type
  guards." It distributes over the union and intersects each member with `RequireNone` of the other members' keys,
  where `export type RequireNone<KeysType extends PropertyKey> = {[Key in KeysType]?: never};`
  (https://github.com/sindresorhus/type-fest/blob/main/source/exclusify-union.d.ts,
  https://github.com/sindresorhus/type-fest/blob/main/source/require-none.d.ts). Its core, two comment lines left out:

  ```ts
  type _ExclusifyUnion<
  	Union,
  	AllKeys extends PropertyKey = DeduplicatedKeys<KeysOfUnion<OmitIndexSignature<Union>>>,
  > = Union extends unknown // For distributing `Union`
  	? SimplifyObject<
  		Union & RequireNone<
  			Exclude<AllKeys, NormalizedKeys<ExactKey<Record<keyof Union | ToString<keyof OmitIndexSignature<Union>>, never>, AllKeys | ToString<AllKeys>>>>
  		>
  	>
  	: never; // Should never happen
  ```

- `RequireExactlyOne<ObjectType, KeysType>`: "Create a type that requires exactly one of the given keys and disallows
  more, while keeping the remaining keys as is." For each key it builds
  `RequireAll<ObjectType, Key> & RequireNone<Exclude<DeduplicatedKeys<AllKeysType>, KeyAliases<Key>>>` and takes the
  union of those (https://github.com/sindresorhus/type-fest/blob/main/source/require-exactly-one.d.ts).
- `RequireOneOrNone<ObjectType, KeysType>`: "Create a type that requires exactly one of the given keys or none of the
  given keys, while keeping the remaining keys as is": the same per-key type, in a union with `RequireNone` of all the
  keys (https://github.com/sindresorhus/type-fest/blob/main/source/require-one-or-none.d.ts).
- Probed against type-fest 5.10.0 installed in a scratch directory (probe-typefest):
  - `ExclusifyUnion<Hold | Human | ActionRef>` and `MergeExclusive<Hold, MergeExclusive<Human, ActionRef>>` are each
    assignable to and from the hand-written X, and refuse the mixes and `{}`;
  - `RequireExactlyOne` and `RequireOneOrNone` cannot express the three forms. They choose among single keys, so the
    Action form's four keys together are refused (TF-x2, TF-n2), `{ visit: 1 }` alone is accepted (TF-x3), and
    `RequireOneOrNone` also accepts `{}` (TF-n1).
- type-fest's readme: "Requires TypeScript >=6, ESM, and `{strict: true}` in your tsconfig" and
  "`{exactOptionalPropertyTypes: true}` is required. Disabling it is unsupported"
  (https://github.com/sindresorhus/type-fest/blob/main/readme.md#install). gg's `tsconfig.json` sets `strict` and not
  `exactOptionalPropertyTypes`, so gg would use it outside what it supports. The probe gave the same six errors with
  the flag on and off.
- gg has no type-fest dependency (`package.json`). A hand-written equivalent is four lines (probe-t), and tsc finds
  its result assignable to and from the hand-written X:

  ```ts
  type KeysOfUnion<Union> = Union extends unknown ? keyof Union : never;
  type Exclusive<Union, Keys extends PropertyKey = KeysOfUnion<Union>> = Union extends unknown
    ? Union & { [Key in Exclude<Keys, keyof Union>]?: never }
    : never;
  ```

  Written without a helper, X costs twelve `?: never` members across the three forms (five, five and two).

### A discriminant in the saved shape (K)

- What the handbook says it buys is quoted above: narrowing on the common literal property, by `if` or `switch`, and
  the `never` exhaustiveness check. Probed: a `switch` on `kind` narrows each case and leaves `never` in `default`;
  `{ kind: 'hold', hold: 'a', human: 'b' }` is refused, "Object literal may only specify known properties, and 'human'
  does not exist in type 'Hold'" (K-b5); a bare `decidedBy.hold` is error TS2339 as under U (K-r1, K-r2).
- That refusal is the excess property check, which runs on object literals only ("Object literals get special
  treatment and undergo _excess property checking_ when assigning them to other variables, or passing them as
  arguments", https://www.typescriptlang.org/docs/handbook/2/objects.html#excess-property-checks). The same mix from a
  variable compiles (K-b9).
- The shape saved today, `{ hold: 'rescue' }`, is not a `DecidedBy` under K (K-b11): every row and every `ticket_end`
  Event already written lacks `kind`.
- What gg's documents say of a change to the saved shape:
  - "Record and Event versions do not change before grey-goo-ri issue #23; a State Database from an earlier slice is
    deleted, not migrated" (`docs/adr/0014-procedures-are-data.md`, Consequences).
  - "The frozen record and event schemas are the JSON documents, not the table layout"
    (`docs/adr/0009-state-database-on-node-sqlite.md`).
  - "Interface freeze: the fake harness, the execution record schema and the event schema are frozen at the end of
    slice 1 before any parallel ticket starts" (`docs/requests/node-harness-dag.md:778`).
  - `lib/record-json.ts`: `SCHEMA_VERSION = 1`; `parseRow` throws `RecordCorruptError` for any other version, and
    holds the precedent for a shape change under the same version: "The version stays 1 until #23, so a cursor from
    before Action ids is told apart by its shape, not misread", after which a cursor with no `recovery` is reported
    corrupt. `parseRow` checks the version, that cursor, and that `visits`, `traversals`, `runs` and `checks` are
    objects. It does not look at `terminalReason`.
  - `lib/record.ts:226`, `assertDeclared`, guards the record's top-level fields only ("would change the record's
    shape after the freeze (#23)").
  - No ADR is about `decidedBy` or a discriminant. Issue #23's own text was not read (this note called no `gh`).
- So under K a row saved before the change either is told apart in `parseRow`, as the cursor is, or is read by the
  one lib reader as a non-hold: `decidedBy.kind === 'hold'` is false for `{ hold: 'interrupted-attempt' }`, and the
  Interrupted Attempt warning of `lib/admission.ts:193` is then silently not given.

### An accessor or a type predicate for the one lib reader

- The handbook: "To define a user-defined type guard, we simply need to define a function whose return type is a _type
  predicate_"; "Any time `isFish` is called with some variable, TypeScript will _narrow_ that variable to that specific
  type if the original type is compatible"
  (https://www.typescriptlang.org/docs/handbook/2/narrowing.html#using-type-predicates).
- Probed over U (probe-accessor): an accessor `holdOf(decidedBy): string | null | undefined` and a predicate
  `isHold(decidedBy): decidedBy is Hold` both compile, and each makes the reader compile. tsc does not check a
  predicate's body against its claim: `isHuman = (decidedBy): decidedBy is Human => 'hold' in decidedBy` compiles.
- Under O, X and T the reader compiles as it stands (measured below: no error at `lib/admission.ts:193`), so an
  accessor has nothing to do. Under U and K it replaces one changed line with one changed line and a new function; the
  six test reads change either way.

### typescript-eslint rules that bear on this

- `eslint.config.mjs` enables none of the four. Its typescript-eslint rules are `naming-convention` and
  `no-misused-spread`; `gg/no-map-to-json` and `gg/thrown-class` are gg's own.
- `no-unnecessary-condition`: "any expression that always evaluates to truthy or always evaluates to falsy, as
  determined by the type of the expression, is considered unnecessary and will be flagged by this rule"
  (https://typescript-eslint.io/rules/no-unnecessary-condition/). In typescript-eslint 8.72.1 it is in
  `strict-type-checked`.
- `prefer-optional-chain`: "This rule reports on code where an `&&` operator can be safely replaced with `?.` optional
  chaining" (https://typescript-eslint.io/rules/prefer-optional-chain/); in `stylistic-type-checked`.
- `no-unsafe-member-access`: "This rule disallows member access on any variable that is typed as `any`"
  (https://typescript-eslint.io/rules/no-unsafe-member-access/); in `recommended-type-checked`.
- `switch-exhaustiveness-check`: "This rule reports when a `switch` statement over a value typed as a union of literals
  or as an enum is missing a case for any of those literal types and does not have a `default` clause"
  (https://typescript-eslint.io/rules/switch-exhaustiveness-check/); in no shared set but `all`.
- Probed with the repository's typescript-eslint 8.72.1 and ESLint 10.14.0, the four rules alone, in the scratch copy
  (probe-lint):
  - `no-unnecessary-condition` reports `lib/admission.ts:193:47`, "Unnecessary optional chain on a non-nullish value":
    the `?.` after `decidedBy`, a required field of `TerminalReason`. That holds under every form.
  - under X it reports the third of three `!== undefined` tests as always true ("the types have no overlap"); under O
    it reports none of them. So with X, lint can see that the forms are exhausted; with O it cannot.
  - `switch-exhaustiveness-check` reports a `switch` on K's `kind` that misses `'action'` and has no `default`. It
    has nothing to report under O, U or X, which give it no union of literals to switch on.
  - `no-unsafe-member-access` reports the reads of `JSON.parse`'s `any` in `parseRow` (`lib/record-json.ts:90` to
    `:110`). It bears on how a row is loaded, not on which form types `decidedBy`.

### Measured on a copy of the tree

Each form replaced `DecidedBy` in `lib/record.ts` of a scratch copy of the working tree (no other change), and
`tsc -p tsconfig.json` ran over the whole copy. The working tree held another session's uncommitted edits to
`lib/json-value.ts` and its test; neither names `decidedBy`, and form O compiled clean in the copy.

| Form | tsc errors | Where |
| --- | --- | --- |
| O | 0 | |
| U, `hold: string \| null` | 10 | the 7 member reads (`lib/admission.ts:193`; `test/support/admission-hold-events.ts:17`; `test/unit/interpreter.faults.test.ts:369`, `interpreter.fix.test.ts:78`, `interpreter.review.test.ts:263` and `:264`, `run.recovery.test.ts:74`) and the 3 `{}` fixtures (`test/unit/terminal-report.test.ts:105` and `:122`, `terminal.test.ts:214`) |
| U, `hold: string` | 11 | those 10 and `lib/terminal.ts:34`, which passes a `string \| null` |
| X | 3 | the 3 `{}` fixtures |
| T (the four-line helper) | 3 | the 3 `{}` fixtures |
| K | 15 | those 10 and the 5 sites that build the value (`lib/terminal.ts:34`, `:46`, `:91`, `:128`; `lib/visit-runner.ts:154`) |

- Under K, tsc cannot see the other 26 test lines that compare the whole object: they pass an untyped literal to
  `assert.deepEqual`. Each would need `kind` once the built value carries it. That was not run.
- X was carried through in the copy: with the three fixtures given a hold form, `tsc` exited 0, ESLint and Prettier
  passed `lib/record.ts`, and `node --test` over `test/unit/terminal.test.ts`, `terminal-report.test.ts` and
  `record.test.ts` passed 42 of 42. The form tried, `{ hold: 'fixture' }`, put two of the fixture lines past 120
  columns for ESLint; `{ hold: null }` is five characters shorter and fits.

### Where the brief for this note was wrong

- It gave the earlier plain-union probe as `{ hold: string } | ...` with 10 errors. With `hold: string` tsc gives 11:
  `lib/terminal.ts:34` passes a `string | null`. The 10 belong to `hold: string | null`.
- It said `docs/requests/node-harness-dag.md:211` describes the field. That line names two of the three forms, the
  Action identity and `{ hold: <name> }`. `{ human: <label> }` is in the code and not in the request document.
- The rest held: `in` narrowing is in the 2.7 and 4.9 notes as cited; #20863, #14094 and #12936 are the issues that
  apply; the readers number 1, 6 and 29, three of them `{}`.

### Probe code and tsc output

The probes are in `C:\Users\James\.claude\jobs\b8927436\tmp\variant-probe\`, with a `tsconfig.json` whose
`compilerOptions` are the repository's plus a `typeRoots` that points at the repository's `node_modules/@types`, and
`include: ["*.ts"]`. A label in the text above names an export of a probe: `U-b5` is `b5` in probe-u.ts, `TF-x2` is
`x2` in probe-typefest.ts. A line with no error below compiled. The command was
`node C:\dev\worktrees\grey-goo-ri\342-save-path-gate\node_modules\typescript\bin\tsc -p <the probe tsconfig.json>`,
which exited 2 with 24 errors in all.

#### probe-o.ts

```ts
// O: one interface, every field optional (the form the PR has).
type Equal<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
interface DecidedBy {
  hold?: string | null;
  human?: string;
  vertex?: string;
  visit?: number | null;
  action?: string | null;
  recovery?: number;
}
declare const decidedBy: DecidedBy;
declare const executionRecord: { terminalReason: { decidedBy: DecidedBy } | null } | null;

export const b1: DecidedBy = { hold: 'rescue' };
export const b2: DecidedBy = { hold: null };
export const b3: DecidedBy = { human: 'gg:needs-human' };
export const b4: DecidedBy = { vertex: 'green', visit: 1, action: 'test', recovery: 0 };
export const b5: DecidedBy = { hold: 'a', human: 'b' }; // O-b5 mix
export const b6: DecidedBy = { hold: 'a', vertex: 'green', visit: 1, action: null, recovery: 0 }; // O-b6 mix
export const b7: DecidedBy = {}; // O-b7 empty
export const b8: DecidedBy = { vertex: 'green' }; // O-b8 partial Action identity
const wide = { hold: 'a', human: 'b' };
export const b9: DecidedBy = wide; // O-b9 mix from a variable

export const r1 = decidedBy.hold;
export const t1: Equal<typeof r1, string | null | undefined> = true;
export const r2 = executionRecord?.terminalReason?.decidedBy?.hold === 'interrupted-attempt';
export const r3 = decidedBy.visit;
export const t3: Equal<typeof r3, number | null | undefined> = true;
export function r4(): number | null {
  if (decidedBy.vertex !== undefined) return decidedBy.visit; // O-r4 vertex present does not prove visit present
  return null;
}
export function r5(): string {
  if (decidedBy.hold !== undefined) return 'hold';
  if (decidedBy.human !== undefined) return 'human';
  if (decidedBy.vertex !== undefined) return 'action';
  const exhaustive: never = decidedBy; // O-r5 nothing left
  return exhaustive;
}
```

```text
probe-o.ts(31,39): error TS2322: Type 'number | null | undefined' is not assignable to type 'number | null'.
  Type 'undefined' is not assignable to type 'number | null'.
probe-o.ts(38,9): error TS2322: Type 'DecidedBy' is not assignable to type 'never'.
```

#### probe-u.ts

```ts
// U: plain union, no discriminant.
interface Hold {
  hold: string | null;
}
interface Human {
  human: string;
}
interface ActionRef {
  vertex: string;
  visit: number | null;
  action: string | null;
  recovery: number;
}
type DecidedBy = Hold | Human | ActionRef;
declare const decidedBy: DecidedBy;
declare const executionRecord: { terminalReason: { decidedBy: DecidedBy } | null } | null;

export const b1: DecidedBy = { hold: 'rescue' };
export const b2: DecidedBy = { hold: null };
export const b3: DecidedBy = { human: 'gg:needs-human' };
export const b4: DecidedBy = { vertex: 'green', visit: 1, action: 'test', recovery: 0 };
export const b5: DecidedBy = { hold: 'a', human: 'b' }; // U-b5 mix
export const b6: DecidedBy = { hold: 'a', vertex: 'green', visit: 1, action: null, recovery: 0 }; // U-b6 mix
export const b7: DecidedBy = {}; // U-b7 empty
export const b8: DecidedBy = { vertex: 'green' }; // U-b8 partial Action identity
const wide = { hold: 'a', human: 'b' };
export const b9: DecidedBy = wide; // U-b9 mix from a variable
export const b10: DecidedBy = { hold: 'a', human: 7 }; // U-b10 mix with a wrong type (TypeScript 3.5)

export const r1 = decidedBy.hold; // U-r1 bare read
export const r2 = executionRecord?.terminalReason?.decidedBy?.hold === 'interrupted-attempt'; // U-r2 lib reader
export const r3 = decidedBy.visit; // U-r3 bare read
export function r4(): string | null {
  if ('hold' in decidedBy) return decidedBy.hold; // in narrows
  return null;
}
export const r6 = 'hold' in decidedBy && decidedBy.hold === 'interrupted-attempt'; // the reader, narrowed
export function r5(): string {
  if ('hold' in decidedBy) return 'hold';
  if ('human' in decidedBy) return 'human';
  if ('vertex' in decidedBy) return 'action';
  const exhaustive: never = decidedBy; // nothing left
  return exhaustive;
}
```

```text
probe-u.ts(24,14): error TS2322: Type '{}' is not assignable to type 'DecidedBy'.
probe-u.ts(25,14): error TS2322: Type '{ vertex: string; }' is not assignable to type 'DecidedBy'.
  Type '{ vertex: string; }' is missing the following properties from type 'ActionRef': visit, action, recovery
probe-u.ts(28,44): error TS2322: Type 'number' is not assignable to type 'string'.
probe-u.ts(30,29): error TS2339: Property 'hold' does not exist on type 'DecidedBy'.
  Property 'hold' does not exist on type 'Human'.
probe-u.ts(31,63): error TS2339: Property 'hold' does not exist on type 'DecidedBy'.
  Property 'hold' does not exist on type 'Human'.
probe-u.ts(32,29): error TS2339: Property 'visit' does not exist on type 'DecidedBy'.
  Property 'visit' does not exist on type 'Hold'.
```

#### probe-x.ts

```ts
// X: union whose members forbid the other members' keys with optional never.
type Equal<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
interface Hold {
  hold: string | null;
  human?: never;
  vertex?: never;
  visit?: never;
  action?: never;
  recovery?: never;
}
interface Human {
  human: string;
  hold?: never;
  vertex?: never;
  visit?: never;
  action?: never;
  recovery?: never;
}
interface ActionRef {
  vertex: string;
  visit: number | null;
  action: string | null;
  recovery: number;
  hold?: never;
  human?: never;
}
type DecidedBy = Hold | Human | ActionRef;
declare const decidedBy: DecidedBy;
declare const executionRecord: { terminalReason: { decidedBy: DecidedBy } | null } | null;

export const b1: DecidedBy = { hold: 'rescue' };
export const b2: DecidedBy = { hold: null };
export const b3: DecidedBy = { human: 'gg:needs-human' };
export const b4: DecidedBy = { vertex: 'green', visit: 1, action: 'test', recovery: 0 };
export const b5: DecidedBy = { hold: 'a', human: 'b' }; // X-b5 mix
export const b6: DecidedBy = { hold: 'a', vertex: 'green', visit: 1, action: null, recovery: 0 }; // X-b6 mix
export const b7: DecidedBy = {}; // X-b7 empty
export const b8: DecidedBy = { vertex: 'green' }; // X-b8 partial Action identity
const wide = { hold: 'a', human: 'b' };
export const b9: DecidedBy = wide; // X-b9 mix from a variable
export const b10: DecidedBy = { human: 'gg:needs-human', hold: undefined }; // X-b10 explicit undefined

export const r1 = decidedBy.hold;
export const t1: Equal<typeof r1, string | null | undefined> = true;
export const r2 = executionRecord?.terminalReason?.decidedBy?.hold === 'interrupted-attempt';
export const r3 = decidedBy.visit;
export const t3: Equal<typeof r3, number | null | undefined> = true;
export function r4(): number | null {
  if (decidedBy.vertex !== undefined) return decidedBy.visit; // vertex present proves visit present
  return null;
}
export function r6(): Hold | null {
  if (decidedBy.hold === 'interrupted-attempt') return decidedBy; // a literal comparison narrows the union
  return null;
}
export function r7(): Hold | null {
  if (decidedBy.hold === null) return decidedBy; // null is the value of a Hold, not a missing key
  return null;
}
export function r8(): string | null {
  if ('hold' in decidedBy) return decidedBy.hold; // X-r8 in does not narrow: every member lists hold
  return null;
}
export function r9(): Human | ActionRef | null {
  if (decidedBy.hold == null) return decidedBy; // X-r9 == null also matches a Hold named null
  return null;
}
export function r5(): string {
  if (decidedBy.hold !== undefined) return 'hold';
  if (decidedBy.human !== undefined) return 'human';
  if (decidedBy.vertex !== undefined) return 'action';
  const exhaustive: never = decidedBy; // nothing left
  return exhaustive;
}
```

```text
probe-x.ts(35,14): error TS2322: Type '{ hold: string; human: string; }' is not assignable to type 'DecidedBy'.
  Types of property 'human' are incompatible.
    Type 'string' is not assignable to type 'undefined'.
probe-x.ts(36,14): error TS2322: Type '{ hold: string; vertex: string; visit: number; action: null; recovery: number; }' is not assignable to type 'DecidedBy'.
  Types of property 'vertex' are incompatible.
    Type 'string' is not assignable to type 'undefined'.
probe-x.ts(37,14): error TS2322: Type '{}' is not assignable to type 'DecidedBy'.
probe-x.ts(38,14): error TS2322: Type '{ vertex: string; }' is not assignable to type 'DecidedBy'.
  Type '{ vertex: string; }' is missing the following properties from type 'ActionRef': visit, action, recovery
probe-x.ts(40,14): error TS2322: Type '{ hold: string; human: string; }' is not assignable to type 'DecidedBy'.
  Type '{ hold: string; human: string; }' is not assignable to type 'Hold'.
    Types of property 'human' are incompatible.
      Type 'string' is not assignable to type 'undefined'.
probe-x.ts(61,28): error TS2322: Type 'string | null | undefined' is not assignable to type 'string | null'.
  Type 'undefined' is not assignable to type 'string | null'.
probe-x.ts(65,31): error TS2322: Type 'DecidedBy' is not assignable to type 'Human | ActionRef | null'.
  Type 'Hold' is not assignable to type 'Human | ActionRef | null'.
    Type 'Hold' is not assignable to type 'ActionRef'.
      Types of property 'vertex' are incompatible.
        Type 'undefined' is not assignable to type 'string'.
```

#### probe-k.ts

```ts
// K: union with a kind discriminant in the saved shape.
interface Hold {
  kind: 'hold';
  hold: string | null;
}
interface Human {
  kind: 'human';
  human: string;
}
interface ActionRef {
  kind: 'action';
  vertex: string;
  visit: number | null;
  action: string | null;
  recovery: number;
}
type DecidedBy = Hold | Human | ActionRef;
declare const decidedBy: DecidedBy;
declare const executionRecord: { terminalReason: { decidedBy: DecidedBy } | null } | null;

export const b1: DecidedBy = { kind: 'hold', hold: 'rescue' };
export const b3: DecidedBy = { kind: 'human', human: 'gg:needs-human' };
export const b4: DecidedBy = { kind: 'action', vertex: 'green', visit: 1, action: 'test', recovery: 0 };
export const b5: DecidedBy = { kind: 'hold', hold: 'a', human: 'b' }; // K-b5 mix
export const b7: DecidedBy = {}; // K-b7 empty
export const b8: DecidedBy = { kind: 'action', vertex: 'green' }; // K-b8 partial Action identity
const wide = { kind: 'hold' as const, hold: 'a', human: 'b' };
export const b9: DecidedBy = wide; // K-b9 mix from a variable
export const b11: DecidedBy = { hold: 'rescue' }; // K-b11 the shape saved today, without kind

export const r1 = decidedBy.hold; // K-r1 bare read
export const r2 = executionRecord?.terminalReason?.decidedBy?.hold === 'interrupted-attempt'; // K-r2 lib reader
export const r6 = decidedBy.kind === 'hold' && decidedBy.hold === 'interrupted-attempt'; // the reader, narrowed
export function r5(): string | number {
  switch (decidedBy.kind) {
    case 'hold':
      return decidedBy.hold ?? 'unnamed';
    case 'human':
      return decidedBy.human;
    case 'action':
      return decidedBy.recovery;
    default: {
      const exhaustive: never = decidedBy; // nothing left
      return exhaustive;
    }
  }
}
```

```text
probe-k.ts(24,57): error TS2353: Object literal may only specify known properties, and 'human' does not exist in type 'Hold'.
probe-k.ts(25,14): error TS2322: Type '{}' is not assignable to type 'DecidedBy'.
probe-k.ts(26,14): error TS2322: Type '{ kind: "action"; vertex: string; }' is not assignable to type 'DecidedBy'.
  Type '{ kind: "action"; vertex: string; }' is missing the following properties from type 'ActionRef': visit, action, recovery
probe-k.ts(29,14): error TS2322: Type '{ hold: string; }' is not assignable to type 'DecidedBy'.
  Property 'kind' is missing in type '{ hold: string; }' but required in type 'Hold'.
probe-k.ts(31,29): error TS2339: Property 'hold' does not exist on type 'DecidedBy'.
  Property 'hold' does not exist on type 'Human'.
probe-k.ts(32,63): error TS2339: Property 'hold' does not exist on type 'DecidedBy'.
  Property 'hold' does not exist on type 'Human'.
```

#### probe-t.ts

```ts
// T: X written by a two-line helper, in place of type-fest's ExclusifyUnion.
type Mutual<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
type KeysOfUnion<Union> = Union extends unknown ? keyof Union : never;
type Exclusive<Union, Keys extends PropertyKey = KeysOfUnion<Union>> = Union extends unknown
  ? Union & { [Key in Exclude<Keys, keyof Union>]?: never }
  : never;

type Hold = { hold: string | null };
type Human = { human: string };
type ActionRef = { vertex: string; visit: number | null; action: string | null; recovery: number };
type DecidedBy = Exclusive<Hold | Human | ActionRef>;

type ByHand =
  | { hold: string | null; human?: never; vertex?: never; visit?: never; action?: never; recovery?: never }
  | { human: string; hold?: never; vertex?: never; visit?: never; action?: never; recovery?: never }
  | { vertex: string; visit: number | null; action: string | null; recovery: number; hold?: never; human?: never };
export const same: Mutual<DecidedBy, ByHand> = true;

declare const decidedBy: DecidedBy;
export const b1: DecidedBy = { hold: 'rescue' };
export const b5: DecidedBy = { hold: 'a', human: 'b' }; // T-b5 mix
export const b7: DecidedBy = {}; // T-b7 empty
export const r1: string | null | undefined = decidedBy.hold;
export function r6(): Hold | null {
  if (decidedBy.hold === 'interrupted-attempt') return decidedBy;
  return null;
}
export function r5(): string {
  if (decidedBy.hold !== undefined) return 'hold';
  if (decidedBy.human !== undefined) return 'human';
  if (decidedBy.vertex !== undefined) return 'action';
  const exhaustive: never = decidedBy;
  return exhaustive;
}
```

```text
probe-t.ts(21,14): error TS2322: Type '{ hold: string; human: string; }' is not assignable to type 'DecidedBy'.
  Types of property 'human' are incompatible.
    Type 'string' is not assignable to type 'undefined'.
probe-t.ts(22,14): error TS2322: Type '{}' is not assignable to type 'DecidedBy'.
```

#### probe-accessor.ts

```ts
// An accessor or a type predicate over the plain union U, for the one lib reader.
interface Hold {
  hold: string | null;
}
interface Human {
  human: string;
}
interface ActionRef {
  vertex: string;
  visit: number | null;
  action: string | null;
  recovery: number;
}
type DecidedBy = Hold | Human | ActionRef;
declare const executionRecord: { terminalReason: { decidedBy: DecidedBy } | null } | null;

export const holdOf = (decidedBy: DecidedBy | null | undefined): string | null | undefined =>
  decidedBy != null && 'hold' in decidedBy ? decidedBy.hold : undefined;
export const isHold = (decidedBy: DecidedBy): decidedBy is Hold => 'hold' in decidedBy;

export const a1 = holdOf(executionRecord?.terminalReason?.decidedBy) === 'interrupted-attempt';
const decided = executionRecord?.terminalReason?.decidedBy;
export const a2 = decided != null && isHold(decided) && decided.hold === 'interrupted-attempt';
// The body of a predicate is not checked against its claim: this one compiles and is wrong.
export const isHuman = (decidedBy: DecidedBy): decidedBy is Human => 'hold' in decidedBy;
```

tsc reported nothing for this file.

#### probe-inferred.ts

```ts
// What tsc infers for a value built as one of the three literals (TypeScript 2.7 normalization).
declare const which: 0 | 1 | 2;
declare const name: string | null;
const inferred =
  which === 0
    ? { hold: name }
    : which === 1
      ? { human: 'gg:needs-human' }
      : { vertex: 'green', visit: 1 as number | null, action: 'test' as string | null, recovery: 0 };
export const hold: string | null | undefined = inferred.hold; // read without narrowing
export const reveal: never = inferred; // I-reveal prints the inferred type
```

```text
probe-inferred.ts(11,14): error TS2322: Type '{ hold: string | null; human?: undefined; vertex?: undefined; visit?: undefined; action?: undefined; recovery?: undefined; } | { human: string; hold?: undefined; vertex?: undefined; visit?: undefined; action?: undefined; recovery?: undefined; } | { ...; }' is not assignable to type 'never'.
  Type '{ hold: string | null; human?: undefined; vertex?: undefined; visit?: undefined; action?: undefined; recovery?: undefined; }' is not assignable to type 'never'.
```

#### probe-typefest.ts

In `C:\Users\James\.claude\jobs\b8927436\tmp\variant-typefest\`, beside type-fest 5.10.0 from npm, compiled with the
same options. With `exactOptionalPropertyTypes` added the same six lines fail, and tsc prints `?: never` where it
prints `?: undefined` here.

```ts
// type-fest 5.10.0 against the three forms.
import type { ExclusifyUnion, MergeExclusive, RequireExactlyOne, RequireOneOrNone } from 'type-fest';

type Mutual<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
type Hold = { hold: string | null };
type Human = { human: string };
type ActionRef = { vertex: string; visit: number | null; action: string | null; recovery: number };
type ByHand =
  | { hold: string | null; human?: never; vertex?: never; visit?: never; action?: never; recovery?: never }
  | { human: string; hold?: never; vertex?: never; visit?: never; action?: never; recovery?: never }
  | { vertex: string; visit: number | null; action: string | null; recovery: number; hold?: never; human?: never };

// ExclusifyUnion: the three forms, each forbidding the keys of the others.
type Exclusified = ExclusifyUnion<Hold | Human | ActionRef>;
export const e0: Mutual<Exclusified, ByHand> = true;
declare const exclusified: Exclusified;
export const e1: Exclusified = { hold: 'a', human: 'b' }; // TF-e1 mix
export const e2: Exclusified = {}; // TF-e2 empty
export const e3: string | null | undefined = exclusified.hold;
export const e4: Exclusified = { vertex: 'green', visit: 1, action: null, recovery: 0 };

// MergeExclusive takes two types; nested for three.
type Merged = MergeExclusive<Hold, MergeExclusive<Human, ActionRef>>;
export const m0: Mutual<Merged, ByHand> = true;
export const m1: Merged = { hold: 'a', human: 'b' }; // TF-m1 mix
export const m2: Merged = { hold: 'a', vertex: 'green', visit: 1, action: null, recovery: 0 }; // TF-m2 mix
export const m3: Merged = { human: 'gg:needs-human' };

// RequireExactlyOne picks one key of one object type: it cannot say the four Action keys go together.
type AllKeys = { hold: string | null; human: string; vertex: string; visit: number | null; action: string | null; recovery: number };
type ExactlyOne = RequireExactlyOne<AllKeys>;
export const x1: ExactlyOne = { hold: 'rescue' };
export const x2: ExactlyOne = { vertex: 'green', visit: 1, action: null, recovery: 0 }; // TF-x2 the Action form
export const x3: ExactlyOne = { visit: 1 }; // TF-x3 a Visit alone

// RequireOneOrNone also admits the empty object.
type OneOrNone = RequireOneOrNone<AllKeys>;
export const n1: OneOrNone = {}; // TF-n1 empty
export const n2: OneOrNone = { vertex: 'green', visit: 1, action: null, recovery: 0 }; // TF-n2 the Action form
```

```text
probe-typefest.ts(17,14): error TS2322: Type '{ hold: string; human: string; }' is not assignable to type '{ hold: string | null; human?: undefined; vertex?: undefined; visit?: undefined; action?: undefined; recovery?: undefined; } | { human: string; hold?: undefined; vertex?: undefined; visit?: undefined; action?: undefined; recovery?: undefined; } | { ...; }'.
  Types of property 'human' are incompatible.
    Type 'string' is not assignable to type 'undefined'.
probe-typefest.ts(18,14): error TS2322: Type '{}' is not assignable to type '{ hold: string | null; human?: undefined; vertex?: undefined; visit?: undefined; action?: undefined; recovery?: undefined; } | { human: string; hold?: undefined; vertex?: undefined; visit?: undefined; action?: undefined; recovery?: undefined; } | { ...; }'.
probe-typefest.ts(25,14): error TS2322: Type '{ hold: string; human: string; }' is not assignable to type '(Without<Hold, (Without<Human, ActionRef> & ActionRef) | (Without<ActionRef, Human> & Human)> & ((Without<...> & ActionRef) | (Without<...> & Human))) | (Without<...> & Hold)'.
  Types of property 'human' are incompatible.
    Type 'string' is not assignable to type 'undefined'.
probe-typefest.ts(26,14): error TS2322: Type '{ hold: string; vertex: string; visit: number; action: null; recovery: number; }' is not assignable to type '(Without<Hold, (Without<Human, ActionRef> & ActionRef) | (Without<ActionRef, Human> & Human)> & ((Without<...> & ActionRef) | (Without<...> & Human))) | (Without<...> & Hold)'.
  Types of property 'vertex' are incompatible.
    Type 'string' is not assignable to type 'undefined'.
probe-typefest.ts(33,14): error TS2322: Type '{ vertex: string; visit: number; action: null; recovery: number; }' is not assignable to type '_RequireExactlyOne<AllKeys, keyof AllKeys>'.
  Types of property 'visit' are incompatible.
    Type 'number' is not assignable to type 'undefined'.
probe-typefest.ts(39,14): error TS2322: Type '{ vertex: string; visit: number; action: null; recovery: number; }' is not assignable to type '_RequireOneOrNone<AllKeys, keyof AllKeys>'.
  Types of property 'visit' are incompatible.
    Type 'number' is not assignable to type 'undefined'.
```

#### probe-lint

Two files placed under `lib/` of the scratch copy, linted with `lib/admission.ts` and `lib/record-json.ts` under a
configuration that enables only the four rules, with the repository's parser and `projectService`.

```ts
// K under switch-exhaustiveness-check: a switch with no default that misses a member.
type DecidedBy =
  | { kind: 'hold'; hold: string | null }
  | { kind: 'human'; human: string }
  | { kind: 'action'; vertex: string; visit: number | null; action: string | null; recovery: number };

export function missing(decidedBy: DecidedBy): string {
  switch (decidedBy.kind) {
    case 'hold':
      return decidedBy.hold ?? 'unnamed';
    case 'human':
      return decidedBy.human;
  }
  return 'action';
}
```

```ts
// X and O under the four rules: the reads each form allows.
type Exclusive =
  | { hold: string | null; human?: never; vertex?: never; visit?: never; action?: never; recovery?: never }
  | { human: string; hold?: never; vertex?: never; visit?: never; action?: never; recovery?: never }
  | { vertex: string; visit: number | null; action: string | null; recovery: number; hold?: never; human?: never };
interface Optional {
  hold?: string | null;
  human?: string;
  vertex?: string;
  visit?: number | null;
  action?: string | null;
  recovery?: number;
}

export function exclusive(decidedBy: Exclusive): string {
  if (decidedBy.hold !== undefined) return 'hold';
  if (decidedBy.human !== undefined) return 'human';
  if (decidedBy.vertex !== undefined) return 'action'; // X-lint the third check is always true
  return 'none';
}
export const reader = (reason: { decidedBy: Exclusive } | null): boolean =>
  reason?.decidedBy?.hold === 'interrupted-attempt'; // X-lint the second ?. is on a required field
export function optional(decidedBy: Optional): string {
  if (decidedBy.hold !== undefined) return 'hold';
  if (decidedBy.human !== undefined) return 'human';
  if (decidedBy.vertex !== undefined) return 'action';
  return 'none';
}
export const parsed = (json: string): unknown => JSON.parse(json).decidedBy.hold; // any from JSON.parse
```

```text
lib/admission.ts
  166:33  error  Unnecessary conditional, expected left-hand side of `??` operator to be possibly null or undefined  @typescript-eslint/no-unnecessary-condition
  193:47  error  Unnecessary optional chain on a non-nullish value                                                   @typescript-eslint/no-unnecessary-condition

lib/record-json.ts
   90:13  error  Unsafe member access .schemaVersion on an `any` value  @typescript-eslint/no-unsafe-member-access
   91:71  error  Unsafe member access .schemaVersion on an `any` value  @typescript-eslint/no-unsafe-member-access
   93:12  error  Unsafe member access .cursor on an `any` value         @typescript-eslint/no-unsafe-member-access
   93:42  error  Unsafe member access .cursor on an `any` value         @typescript-eslint/no-unsafe-member-access
  110:16  error  Unsafe member access .visitState on an `any` value     @typescript-eslint/no-unsafe-member-access

lib/variant-probe/probe-lint-k.ts
  8:11  error  Switch is not exhaustive. Cases not matched: "action"  @typescript-eslint/switch-exhaustiveness-check

lib/variant-probe/probe-lint-x.ts
  18:7   error  Unnecessary conditional, the types have no overlap  @typescript-eslint/no-unnecessary-condition
  22:20  error  Unnecessary optional chain on a non-nullish value   @typescript-eslint/no-unnecessary-condition
  29:67  error  Unsafe member access .decidedBy on an `any` value   @typescript-eslint/no-unsafe-member-access

✖ 11 problems (11 errors, 0 warnings)
```

## Comparison

"Sites" counts the 10 the plain union breaks: the 7 member reads and the 3 `{}` fixtures.

| Form | A mix such as `{ hold, human }` compiles | `{}` compiles | How one member is read | Sites of the 10 that change | Saved JSON changes | Primary source for it |
| --- | --- | --- | --- | --- | --- | --- |
| O: one interface, all optional | yes, and so does a partial Action identity | yes | bare read, `T \| undefined`; no test narrows the rest; no exhaustiveness | 0 | no | none; the handbook shows optional members as the encoding to leave |
| U: plain union | yes, as a literal and from a variable; refused only when a property's type is wrong | no | error TS2339 until `'hold' in decidedBy`; exhaustive by `in` | 10 | no | handbook, `in` narrowing; 2.7 note; 3.5 note and #20863 for the mix |
| X: union with the other keys as optional `never` | no, as a literal or from a variable | no | bare read, `T \| undefined`; `=== 'x'`, `=== null` and `!== undefined` narrow; `in` and `== null` do not; exhaustive | 3 | no | 3.2 note (an `undefined` property is a discriminant); 2.7 note (the compiler infers this type); RyanCavanaugh in #14094 and #20863 |
| T: X through a helper | as X | no | as X | 3 | no | type-fest `ExclusifyUnion`, which needs a flag gg does not set; or four lines of gg's own |
| K: union with `kind` | a literal no; from a variable yes | no | error TS2339 until `kind` is tested; `switch` narrows; exhaustive | 10, and the 5 sites that build it, and 26 comparisons tsc cannot see | yes: every row and `ticket_end` Event, and rows already saved lack it | handbook, discriminated unions |

O is the only form that accepts what gg never builds, and the only one under which no test of one field says anything
of another. U refuses `{}` but accepts every mix, and is the dearest of the forms that leave the JSON alone. X and T
are one type; they differ in who writes the `never` members. K is the handbook's form and the only one that changes
what is saved.

## Recommendation for gg

Decided 2026-11-11 (owner, #342): X, the second resolution below. `record.DecidedBy` is that union, the three `{}`
fixtures hold a real form, and `test/unit/record.test.ts` has a case for the five values gg builds and the three it
must not.

Three resolutions for the owner. Each leaves the five sites that build the value as they are, except the third.

1. **Keep O**, the interface of six optional fields.
   - Does: nothing changes. The type says "any subset of six fields".
   - Costs: 0 sites.
   - tsc: `{ hold, human }`, a Hold with the Action keys, `{ vertex }` alone and `{}` all compile; `vertex` present
     does not give `visit` (error at O-r4); three tests do not exhaust the value (error at O-r5).
   - Rests on: no source. It is the encoding the handbook's discriminated-union section starts from and replaces.

2. **X, written by hand in `lib/record.ts`** (recommended): the union of the three forms, each listing the other
   forms' keys as `?: never`, as in probe-x; and the three `{}` fixtures given one of the three forms.
   - Does: the type says "exactly one of the three". Every reader keeps its text: `decidedBy.hold`, `.vertex` and
     `.visit` are read bare, and `lib/admission.ts:193` is untouched. The saved JSON is byte for byte what it is now.
   - Costs: 3 sites, all test fixtures (`test/unit/terminal-report.test.ts:105` and `:122`,
     `test/unit/terminal.test.ts:214`), and twelve `?: never` members in the type.
   - tsc: every mix refused, as a literal and from a variable; `{}` and a partial Action identity refused; a literal
     comparison, `=== null` and `!== undefined` narrow; three tests leave `never`. In the copy: `tsc` 0 errors, 42 of
     42 tests of the three touched suites.
   - Rests on: it is the type TypeScript infers for the three literals (2.7 note, probe-inferred); an `undefined`
     property has been a discriminant since 3.2; a TypeScript team member wrote of the `?: never` helpers that they
     "seem like good fits for what we would have implemented anyway" (#14094) and recommended "choosing one of those"
     (#20863); it is the one form that leaves the JSON alone and for which tsc refused every impossible value probed;
     its measured cost is the lowest of the forms that refuse `{}`.
   - Carries two rules a comment on the type should state: a reader narrows with `!== undefined` or a literal, never
     with `in` (X-r8) or `== null` (X-r9); and a fourth form adds its keys to the other three.

3. **K, a `kind` in the saved shape, decided with #23** rather than in #342.
   - Does: the handbook's discriminated union. `switch (decidedBy.kind)` narrows, and `switch-exhaustiveness-check`
     could then hold it in lint.
   - Costs: 15 sites by tsc (the 10 and the 5 that build the value), 26 test comparisons tsc cannot see, the
     request document's line 211, and a decision for rows and Events already saved: told apart in `parseRow` as the
     pre-#111 cursor is, or deleted under ADR 0014's rule.
   - tsc: a literal mix refused (K-b5), the same mix from a variable accepted (K-b9), today's saved shape refused
     (K-b11), every bare read an error (K-r1, K-r2).
   - Rests on: the handbook recommends it and names messages sent over a network as a use. Against it for #342: ADR
     0014 keeps the Record and Event versions as they are until #23, and nothing gg reads needs the discriminant today
     (one reader, of one member). No source read here supports changing the saved shape now.

Not offered, with the deciding fact. **U**: it costs all 10 sites and still compiles `{ hold: 'a', human: 'b' }`,
which the team calls the standing behaviour of unions (#20863); X costs 3 and refuses it. **T through type-fest**: a
new dependency for one type, used with `exactOptionalPropertyTypes` off, which its readme calls unsupported. **T
through gg's own helper**: the same type as X for four more lines; worth it when a second such value or a fourth form
arrives, not for three forms in one place. **An accessor or predicate**: nothing to do under O or X, and under U it
moves the `in` test without removing it.

## Open questions

1. Which form should each of the three `{}` fixtures carry? A fault and a replan save the Action form in a real run;
   `{ hold: null }` is the shortest that compiles and keeps each line inside 120 columns.
2. Can a Hold's name be `null` in a real run? `terminal.hold` defaults only an absent name to `'reconciliation'`, and
   `lib/interpreter.ts:66` passes an admission stop whose `name` is `string | null`. If no caller gives `null`, the
   Hold form could be `{ hold: string }` and `== null` would be safe under X. Not traced here.
3. A loaded row is not checked under any form: `parseRow` returns `JSON.parse`'s `any` through `fromJson`, so a row
   holding `{}` or a mix loads as a `DecidedBy`. Whether `terminalReason` gets a shape check belongs with #23's
   freeze.
4. Should the request document name `{ human: <label> }` at line 211? The code builds it and the document does not
   describe it.
5. Would `exactOptionalPropertyTypes` pay for itself across the tree? It closes X-b10 and is what type-fest requires.
   Its cost in gg was not measured.
6. Would `no-unnecessary-condition` pay for itself? It reports the redundant `?.` at `lib/admission.ts:193` and one
   more condition in that file, and under X it reports a test that can no longer fail. Its count across the tree was
   not measured.
7. Does #23 already reserve a discriminant for `decidedBy`? Its text was not read.
