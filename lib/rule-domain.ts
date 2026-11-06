// A Rule Table's finite domain (R8, N2): each field partitioned into one value per equivalence class, each box's points
// enumerated against bit masks of the rows that match there, and the two passes rules.analyse reads its errors and
// warnings from.

import * as procedures from './procedures.ts';
import * as referencePaths from './reference-paths.ts';
import type * as rules from './rules.ts';

// The nearest integer on either side of `constant`; beyond 2**53 doubles are integers one ulp apart, so step the bit
// pattern.
const f64 = new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);
function beside(constant: number, step: number) {
  if (Math.abs(constant) < 2 ** 53) return constant + step;
  f64[0] = constant;
  i64[0] += BigInt(step * Math.sign(constant));
  return f64[0];
}

// An absent value (undefined) matches no condition (T10).
export function matches(condition: rules.Condition, value: unknown) {
  if (value === undefined) return false;
  if (condition === null || typeof condition !== 'object') return value === condition;
  if (!Number.isInteger(value)) return false;
  for (const [operator, operand] of Object.entries(condition))
    if (!procedures.COMPARISONS[operator as procedures.Operator](value as number, operand)) return false;
  return true;
}

export type Value = rules.RuleValue | undefined;
// One value per equivalence class: every constant and its neighbours represent the intervals between and outside them.
export function partition(spec: rules.FieldSpec, conditions: rules.Condition[]) {
  let values: Value[];
  if (spec.kind === 'enum') values = [...spec.values];
  else if (spec.kind === 'boolean') values = [true, false];
  else {
    const { min, max } = spec;
    const cuts = new Set([min, max].filter((bound): bound is number => Number.isInteger(bound)));
    for (const condition of conditions)
      for (const constant of typeof condition === 'object' ? Object.values(condition as object) : [condition])
        cuts.add(beside(constant, -1)).add(constant).add(beside(constant, 1));
    values = [...cuts]
      .filter(
        (cut) => Number.isFinite(cut) && (min === undefined || !(cut < min)) && (max === undefined || !(cut > max)),
      )
      .sort((left, right) => left - right);
  }
  if (spec.absent) values.push(undefined);
  return values;
}

// A point of the domain: its box, then the index of its value in each field's partition.
export type Point = number[];
// The table's finite domain: per box, each field's representative values (`values[box][field]`) and how many points
// the box holds; `masks[box][field][value]` has bit i set when row i places no condition on the field or its condition
// holds for the value.
export interface Domain {
  name: string;
  rows: rules.RuleRow[];
  paths: string[];
  values: Value[][][];
  points: number[];
  words: number;
  masks: Uint32Array[][][];
}

function bitsOf(rows: rules.RuleRow[], words: number, keep: (row: rules.RuleRow) => boolean) {
  const bits = new Uint32Array(words);
  rows.forEach((row, i) => {
    if (keep(row)) bits[i >> 5] |= 1 << (i & 31);
  });
  return bits;
}
export const has = (bits: Uint32Array, i: number) => (bits[i >> 5] >>> (i & 31)) & 1;
export const lowest = (bits: number) => 31 - Math.clz32(bits & -bits);

// The domain of `values` (per box, per field), with each value's mask of the rows that match it.
export function domainOf(table: Omit<Domain, 'words' | 'masks'>): Domain {
  const { rows, paths, values } = table;
  const words = Math.max(1, Math.ceil(rows.length / 32));
  const masks = values.map((box) =>
    box.map((fieldValues, field) =>
      fieldValues.map((value) =>
        bitsOf(rows, words, (row) => !Object.hasOwn(row.when, paths[field]) || matches(row.when[paths[field]], value)),
      ),
    ),
  );
  return { ...table, words, masks };
}

// Calls `visit` at each point of the domain with the rows of `base` that match there; `point` is reused between calls.
function enumerate(domain: Domain, base: Uint32Array, visit: (matching: Uint32Array, point: Point) => void) {
  const { paths, values, points, words, masks } = domain;
  const matching = new Uint32Array(words);
  values.forEach((boxValues, box) => {
    const point = [box, ...paths.map(() => 0)];
    for (let visited = 0; visited < points[box]; visited++) {
      matching.set(base);
      for (let field = 0; field < paths.length; field++) {
        const fieldMask = masks[box][field][point[field + 1]];
        for (let word = 0; word < words; word++) matching[word] &= fieldMask[word];
      }
      visit(matching, point);
      for (let field = 0; field < paths.length && ++point[field + 1] === boxValues[field].length; field++)
        point[field + 1] = 0;
    }
  });
}

// The first pass: which rows are reached and which fire, in memory linear in the rows, and per box the first point no
// row matches.
export function reachedRows(domain: Domain) {
  const { rows, words } = domain;
  const reached = new Uint32Array(words);
  const fires = new Uint32Array(words);
  const fallen: Point[] = [];
  enumerate(
    domain,
    bitsOf(rows, words, () => true),
    (matching, point) => {
      let word = 0;
      for (; word < words && !matching[word]; word++);
      if (word === words) fallen[point[0]] ??= point.slice();
      else fires[word] |= matching[word] & -matching[word];
      for (; word < words; word++) reached[word] |= matching[word];
    },
  );
  return { reached, fires, fallen };
}

// The second pass, over firing rows only: takers[i] has bit j when row j is the first match at a point row i matches,
// and taken[i] is the first such point. Only firing rows get bits, so they take at most points * rows bits, which the
// work limit bounds.
export function takenRows(domain: Domain, fires: Uint32Array) {
  const takers: Uint32Array[] = [];
  const taken: Point[] = [];
  enumerate(domain, fires, (matching, point) => {
    let j = -1;
    for (let word = 0; word < domain.words; word++) {
      for (let bits = matching[word]; bits; bits &= bits - 1) {
        const i = word * 32 + lowest(bits);
        if (j < 0) {
          j = i;
          continue;
        }
        (takers[i] ??= new Uint32Array(domain.words))[j >> 5] |= 1 << (j & 31);
        taken[i] ??= point.slice();
      }
    }
  });
  return { takers, taken };
}

export function example(domain: Domain, [box, ...indices]: Point) {
  const input: Record<string, unknown> = {};
  domain.paths.forEach((path, field) => {
    const value = domain.values[box][field][indices[field]];
    if (value !== undefined) referencePaths.write(input, path, value);
  });
  return input;
}
