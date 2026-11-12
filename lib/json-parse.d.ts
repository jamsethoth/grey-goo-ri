// JSON.parse gives `unknown` in gg, so tsc refuses its result wherever no check has narrowed it (#354). Merged
// interfaces order later overload sets first, so this one wins over lib.es5's `any` (ts-reset's json-parse rule). The
// file has no import or export: it merges into the global JSON.
interface JSON {
  parse(text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): unknown;
}
