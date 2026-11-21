// The tests of a configured value every part of the validator shares, which lib/validate/report.ts gives them.

import * as referencePaths from '../reference-paths.ts';

// A string key only: Object.hasOwn would coerce a list such as ["push"] to the key it spells.
export function hasOwnKey<T extends object>(value: T, key: unknown): key is Extract<keyof T, string>;
export function hasOwnKey(value: unknown, key: unknown): key is string;
export function hasOwnKey(value: unknown, key: unknown) {
  return typeof key === 'string' && referencePaths.isRecord(value) && Object.hasOwn(value, key);
}
// A configured value as gg shows it: a string or number as written, anything else as JSON, so a value of the wrong
// type never shows as [object Object] or a blank (#305). A number past the largest double parses to Infinity, which
// JSON would spell null.
export const shown = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value);
export const isName = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
export const isCount = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
export const entries = (value: unknown) => (referencePaths.isRecord(value) ? Object.entries(value) : []);
export const unique = <T>(list: T[]) => [...new Set(list)];
