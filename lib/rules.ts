// Rule Tables: first-match evaluation and exact analysis over the table's finite domain partition (R8, V5, N2).

import type * as procedures from './procedures.ts';
import * as referencePaths from './reference-paths.ts';
import * as ruleDomain from './rule-domain.ts';
import * as report from './validate/report.ts';

export type RuleValue = string | number | boolean;
// A row's condition on one field: the value it must equal, or integer comparisons that must all hold.
export type Condition = RuleValue | null | Partial<Record<procedures.Operator, number>>;
export interface RuleRow {
  when: Record<string, Condition>;
  outcome: string;
}
// A field's domain (J15): an enum's values, a boolean, or an integer within optional bounds; `absent` adds the absent
// value (T10).
export type FieldSpec = (
  { kind: 'enum'; values: string[] } | { kind: 'boolean' } | { kind: 'integer'; min?: number; max?: number }
) & { absent?: boolean };
export type FieldMap = Record<string, FieldSpec>;
// A table to analyse: its rows over `fields`, or over the union of `boxes`, each a field map like `fields` (J16).
export interface RuleTable {
  name: string;
  rows: RuleRow[];
  fields?: FieldMap;
  boxes?: FieldMap[];
}
type Example = Record<string, unknown>;
// A type, not an interface: an interface cannot extend Finding, which gives each code its own params.
export type RuleError = report.Finding<
  'never-firing-row' | 'rule-table-too-large' | 'undeclared-rule-field' | 'unreachable-row'
> & { row: number | null };
// Rows `rows` (first and last, by index) are each partly taken by the `earlier` row ranges it names, `more` beyond
// them, or by every earlier firing row from row `from` on.
export interface OverlapWarning extends report.Overlap {
  // The conditions the sentence quotes: the taken row's, then each named earlier row's; none for a run.
  conditions: { row: number; when: Record<string, Condition> }[];
  code: 'overlapping-rows';
  message: string;
}
export interface Analysis {
  errors: RuleError[];
  warnings: OverlapWarning[];
  defaultExample: Example | null;
  falls: number[];
}

// Measured in #103 (Node 24.15, Windows): the example Flow's five tables take 0.1 ms together; a table near the limit
// takes 0.2 s (20 booleans, 9 rows) to 0.75 s (a 3,000-row ladder where every row overlaps every earlier one). So an
// admission with one table near the limit stays under a second.
export const WORK_LIMIT = 10_000_000;
// A warning names at most this many earlier rows and counts the rest, so its size does not grow with the table.
const NAMED = 10;

export function evaluate(table: { rows: RuleRow[] }, input: unknown) {
  const i = table.rows.findIndex((row) =>
    Object.entries(row.when).every(([path, condition]) =>
      ruleDomain.matches(condition, referencePaths.read(input, path)),
    ),
  );
  return i < 0 ? null : i;
}

export const conditions = (when: Record<string, Condition>) =>
  Object.entries(when)
    .flatMap(([path, condition]) =>
      // An empty object or a list is no comparison, so it shows whole rather than vanishing from the row (#305).
      referencePaths.isRecord(condition) && Object.keys(condition).length
        ? Object.entries(condition).map(([operator, operand]) => `${path} ${operator} ${report.shown(operand)}`)
        : [`${path} = ${report.shown(condition)}`],
    )
    .join(' and ') || 'no conditions';

const refuse = (error: report.Finding<'rule-table-too-large' | 'undeclared-rule-field'>): Analysis => ({
  errors: [{ row: null, ...error }],
  warnings: [],
  defaultExample: null,
  falls: [],
});

function overLimit(name: string, paths: string[], values: ruleDomain.Value[][][], work: number): Analysis {
  const largest = paths
    .map((path, field): [string, number] => [path, Math.max(...values.map((box) => box[field].length))])
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3);
  return refuse({
    code: 'rule-table-too-large',
    message:
      `rule table ${name} needs ${work} row checks, above the limit of ${WORK_LIMIT}; ` +
      `its largest fields: ${largest.map(([path, count]) => `${path} (${count} values)`).join(', ')}`,
    params: { table: name, work, limit: WORK_LIMIT, largest },
  });
}

const neverFiring = (domain: ruleDomain.Domain, reached: Uint32Array, fires: Uint32Array): RuleError[] =>
  domain.rows.flatMap((row, i): RuleError[] =>
    ruleDomain.bitAt(fires, i)
      ? []
      : [
          {
            row: i,
            code: ruleDomain.bitAt(reached, i) ? 'never-firing-row' : 'unreachable-row',
            message:
              `rule table ${domain.name}: row ${i + 1} (${row.outcome}) ` +
              (ruleDomain.bitAt(reached, i)
                ? 'never fires: earlier rows match every input it matches'
                : 'is unreachable: it matches no input'),
            params: { table: domain.name, row: i, outcome: row.outcome },
          },
        ],
  );

// Overlap warnings, one per partly taken row. Adjacent rows on the same fields share one when each is taken by every
// firing row from the same row on, or all by the same rows. Takers are ranges of row indices, and a run keeps only its
// first row's, so a ladder costs one warning, not a list per row.
interface Run {
  rows: [number, number];
  earlier: [number, number][];
  more: number;
  from: number;
  relative: boolean;
  fieldsKey: string;
  fields: string[];
  mode: 'same' | 'from' | null;
  example: Example;
  firingBefore: Int32Array;
}
// A row's taker set and what decides whether it joins the open run.
interface Taken {
  i: number;
  from: number;
  relative: boolean;
  setKey: string;
  fieldsKey: string;
}

// Whether the ascending `list` holds a value from `first` to `last`.
function anyIn(list: number[], first: number, last: number) {
  let low = 0;
  for (let high = list.length; low < high;) {
    const middle = (low + high) >> 1;
    if (list[middle] < first) low = middle + 1;
    else high = middle;
  }
  return list[low] <= last;
}

// A taker set as ascending ranges of row indices, and how many rows it holds.
function rangesOf(takerBits: Uint32Array) {
  const ranges: [number, number][] = [];
  let count = 0;
  takerBits.forEach((wordBits, word) => {
    for (let bits = wordBits; bits; bits &= bits - 1, count++) {
      const j = word * 32 + ruleDomain.lowestBit(bits);
      const last = ranges.at(-1);
      if (last?.[1] === j - 1) last[1] = j;
      else ranges.push([j, j]);
    }
  });
  return { ranges, count };
}

// The first NAMED rows of `ranges`, as ranges.
function namedRanges(ranges: [number, number][]) {
  const earlier: [number, number][] = [];
  for (let i = 0, left = NAMED; left > 0 && i < ranges.length; i++) {
    const [first, last] = ranges[i];
    const named: [number, number] = [first, Math.min(last, first + left - 1)];
    earlier.push(named);
    left -= named[1] - first + 1;
  }
  return earlier;
}

// Extends the open run with row `taken.i` when the run ends at the row before it, on the same fields, and is taken by
// the same rows or by every firing row from the same row on.
function extendRun(run: Run | undefined, taken: Taken, openSet: string | null) {
  if (run?.rows[1] !== taken.i - 1 || run.fieldsKey !== taken.fieldsKey) return false;
  if (run.mode !== 'from' && taken.setKey === openSet) {
    run.mode = 'same';
    run.rows[1] = taken.i;
    return true;
  }
  if (run.mode !== 'same' && taken.relative && run.relative && taken.from === run.from) {
    run.mode = 'from';
    run.rows[1] = taken.i;
    return true;
  }
  return false;
}

function overlapRuns(domain: ruleDomain.Domain, fires: Uint32Array, takers: Uint32Array[], taken: ruleDomain.Point[]) {
  const { rows, paths } = domain;
  const firingBefore = new Int32Array(rows.length + 1);
  rows.forEach((_, i) => {
    firingBefore[i + 1] = firingBefore[i] + ruleDomain.bitAt(fires, i);
  });
  // The firing rows with a condition on each field, ascending.
  const firingOn = new Map<string, number[]>(paths.map((path) => [path, []]));
  rows.forEach((row, i) => {
    if (ruleDomain.bitAt(fires, i)) for (const path of Object.keys(row.when)) firingOn.get(path)?.push(i);
  });
  const runs: Run[] = [];
  // The open run's full taker ranges, as a key; closed runs keep only their named rows.
  let openSet: string | null = null;
  rows.forEach((row, i) => {
    if (!takers[i]) return;
    const { ranges, count } = rangesOf(takers[i]);
    const from = ranges[0][0];
    const relative = count === firingBefore[i] - firingBefore[from];
    const fields = paths
      .filter(
        (path) =>
          Object.hasOwn(row.when, path) ||
          ranges.some(([first, last]) => anyIn(firingOn.get(path) as number[], first, last)),
      )
      .sort();
    const setKey = JSON.stringify(ranges);
    const fieldsKey = JSON.stringify(fields);
    if (extendRun(runs.at(-1), { i, from, relative, setKey, fieldsKey }, openSet)) return;
    openSet = setKey;
    runs.push({
      rows: [i, i],
      earlier: namedRanges(ranges),
      more: Math.max(0, count - NAMED),
      from,
      relative,
      fieldsKey,
      fields,
      mode: null,
      example: ruleDomain.example(domain, taken[i]),
      firingBefore,
    });
  });
  return runs;
}

const named = (ranges: [number, number][]) =>
  ranges.map(([first, last]) => (first === last ? `row ${first + 1}` : `rows ${first + 1}-${last + 1}`)).join(', ');

function takersText(run: Run, rest: string) {
  if (run.mode === 'same') return named(run.earlier) + rest;
  if (run.firingBefore[run.from] === 0) return 'every earlier firing row';
  return `every earlier firing row from row ${run.from + 1}`;
}

function overlapWarning({ name, rows }: ruleDomain.Domain, run: Run): OverlapWarning {
  const {
    rows: [first, last],
    earlier,
    more,
    from,
    fields,
    mode,
  } = run;
  const rest = more ? `, and ${more} more ${more === 1 ? 'row' : 'rows'}` : '';
  const named = earlier.flatMap(([low, high]) => Array.from({ length: high - low + 1 }, (_, offset) => low + offset));
  const quoted = first === last ? [first, ...named] : [];
  const message =
    first === last
      ? `row ${first + 1} (${conditions(rows[first].when)}) is partly taken by ` +
        named.map((row) => `row ${row + 1} (${conditions(rows[row].when)})`).join(', ') +
        rest
      : `rows ${first + 1}-${last + 1} are each partly taken by ${takersText(run, rest)}, all on ${fields.join(', ')}`;
  return {
    rows: [first, last],
    earlier,
    more,
    from: mode === 'from' ? from : null,
    fields,
    example: run.example,
    table: name,
    conditions: quoted.map((row) => ({ row, when: rows[row].when })),
    code: 'overlapping-rows',
    message: `rule table ${name}: ${message}, for example ${JSON.stringify(run.example)}`,
  };
}

// The domain is `fields`, or the union of `boxes`, each a field map like `fields` (J16). Everything is decided over the
// whole domain; `falls` lists the boxes with an input no row matches.
export function analyse(table: RuleTable): Analysis {
  const { name, rows } = table;
  const boxes = table.boxes ?? [table.fields as FieldMap];
  const paths = [...new Set(rows.flatMap((row) => Object.keys(row.when)))];
  const undeclared = paths.filter((path) => !boxes.every((fields) => Object.hasOwn(fields, path)));
  if (undeclared.length)
    return refuse({
      code: 'undeclared-rule-field',
      message: `rule table ${name} names undeclared fields: ${undeclared.join(', ')}`,
      params: { table: name, fields: undeclared },
    });
  const values = boxes.map((fields) =>
    paths.map((path) =>
      ruleDomain.partition(
        fields[path],
        rows.flatMap((row) => (Object.hasOwn(row.when, path) ? [row.when[path]] : [])),
      ),
    ),
  );
  const points = values.map((box) => box.reduce((count, fieldValues) => count * fieldValues.length, 1));
  const work = points.reduce((sum, count) => sum + count, 0) * rows.length;
  if (work > WORK_LIMIT) return overLimit(name, paths, values, work);

  const domain = ruleDomain.domainOf({ name, rows, paths, values, points });
  const { reached, fires, fallen } = ruleDomain.reachedRows(domain);
  const { takers, taken } = ruleDomain.takenRows(domain, fires);
  const errors = neverFiring(domain, reached, fires);
  const warnings = overlapRuns(domain, fires, takers, taken).map((run) => overlapWarning(domain, run));
  const first = fallen.find(Boolean);
  return {
    errors,
    warnings,
    defaultExample: first ? ruleDomain.example(domain, first) : null,
    falls: [...fallen.keys()].filter((box) => fallen[box]),
  };
}
