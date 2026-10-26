// Rule Tables: first-match evaluation and exact analysis over the table's finite domain partition (R8, V5, N2).

// Measured in #103 (Node 24.15, Windows): the example Flow's five tables take 0.1 ms together; a table near the limit
// takes 0.2 s (20 booleans, 9 rows) to 0.75 s (a 3,000-row ladder where every row overlaps every earlier one). So an
// admission with one table near the limit stays under a second.
export const WORK_LIMIT = 10_000_000;

const OPS = {
  '<': (v, c) => v < c,
  '<=': (v, c) => v <= c,
  '>': (v, c) => v > c,
  '>=': (v, c) => v >= c,
  '=': (v, c) => v === c,
};

function get(input, path) {
  let v = input;
  for (const key of path.split('.')) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, key)) return undefined;
    v = v[key];
  }
  return v;
}

// Own data properties only, so a key such as __proto__ never reaches a prototype.
const own = (o, key, value) => Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });

function set(input, path, value) {
  const keys = path.split('.');
  let o = input;
  for (const key of keys.slice(0, -1)) o = Object.hasOwn(o, key) ? o[key] : own(o, key, {})[key];
  own(o, keys.at(-1), value);
}

// The nearest integer on either side of c; beyond 2**53 doubles are integers one ulp apart, so step the bit pattern.
const f64 = new Float64Array(1);
const i64 = new BigInt64Array(f64.buffer);
function beside(c, dir) {
  if (Math.abs(c) < 2 ** 53) return c + dir;
  f64[0] = c;
  i64[0] += BigInt(dir * Math.sign(c));
  return f64[0];
}

// An absent value (undefined) matches no condition (T10).
function matches(cond, v) {
  if (v === undefined) return false;
  if (cond === null || typeof cond !== 'object') return v === cond;
  if (!Number.isInteger(v)) return false;
  for (const op of Object.keys(cond)) if (!OPS[op](v, cond[op])) return false;
  return true;
}

export function evaluate(table, input) {
  const i = table.rows.findIndex(row => Object.entries(row.when).every(([path, cond]) => matches(cond, get(input, path))));
  return i < 0 ? null : i;
}

// One value per equivalence class: every constant and its neighbours represent the intervals between and outside them.
function partition(spec, conds) {
  let values;
  if (spec.kind === 'enum') values = [...spec.values];
  else if (spec.kind === 'boolean') values = [true, false];
  else {
    const cuts = new Set([spec.min, spec.max].filter(Number.isInteger));
    for (const cond of conds) for (const c of typeof cond === 'object' ? Object.values(cond) : [cond]) cuts.add(beside(c, -1)).add(c).add(beside(c, 1));
    values = [...cuts].filter(v => Number.isFinite(v) && !(v < spec.min) && !(v > spec.max)).sort((a, b) => a - b);
  }
  if (spec.absent) values.push(undefined);
  return values;
}

const conditions = when => Object.entries(when)
  .flatMap(([p, c]) => c !== null && typeof c === 'object' ? Object.entries(c).map(([op, v]) => `${p} ${op} ${v}`) : [`${p} = ${c}`])
  .join(' and ') || 'no conditions';

const refuse = message => ({ errors: [{ row: null, message }], warnings: [], defaultExample: null });

export function analyse(table) {
  const { name, fields, rows } = table;
  const paths = [...new Set(rows.flatMap(r => Object.keys(r.when)))];
  const undeclared = paths.filter(p => !Object.hasOwn(fields, p));
  if (undeclared.length) return refuse(`rule table ${name} names undeclared fields: ${undeclared.join(', ')}`);
  const domains = paths.map(p => partition(fields[p], rows.flatMap(r => Object.hasOwn(r.when, p) ? [r.when[p]] : [])));
  const points = domains.reduce((n, d) => n * d.length, 1);
  const work = points * rows.length;
  if (work > WORK_LIMIT) {
    const largest = paths.map((p, f) => [p, domains[f].length]).sort((a, b) => b[1] - a[1]).slice(0, 3);
    return refuse(`rule table ${name} needs ${work} row checks, above the limit of ${WORK_LIMIT}; ` +
      `its largest fields: ${largest.map(([p, n]) => `${p} (${n} values)`).join(', ')}`);
  }

  // masks[f][v]: bit i is set when row i places no condition on field f or its condition holds for value v.
  const words = Math.max(1, Math.ceil(rows.length / 32));
  const bitsOf = keep => {
    const m = new Uint32Array(words);
    rows.forEach((r, i) => { if (keep(r, i)) m[i >> 5] |= 1 << (i & 31); });
    return m;
  };
  const has = (m, i) => (m[i >> 5] >>> (i & 31)) & 1;
  const lowest = b => 31 - Math.clz32(b & -b);
  const masks = domains.map((values, f) => values.map(v => bitsOf(r => !Object.hasOwn(r.when, paths[f]) || matches(r.when[paths[f]], v))));
  const enumerate = (base, visit) => {
    const idx = new Array(paths.length).fill(0);
    const m = new Uint32Array(words);
    for (let p = 0; p < points; p++) {
      m.set(base);
      for (let f = 0; f < paths.length; f++) {
        const fm = masks[f][idx[f]];
        for (let w = 0; w < words; w++) m[w] &= fm[w];
      }
      visit(m, idx);
      for (let f = 0; f < paths.length && ++idx[f] === domains[f].length; f++) idx[f] = 0;
    }
  };

  // First pass: which rows are reached and which fire, in memory linear in the rows.
  const reached = new Uint32Array(words);
  const fires = new Uint32Array(words);
  let fallen = null;
  enumerate(bitsOf(() => true), (m, idx) => {
    let w = 0;
    for (; w < words && !m[w]; w++);
    if (w === words) fallen ??= idx.slice();
    else fires[w] |= m[w] & -m[w];
    for (; w < words; w++) reached[w] |= m[w];
  });

  // Second pass, over firing rows only: takers[i] has bit j when row j is the first match at a point row i matches.
  // Only firing rows get bits, so they take at most points * rows bits, which the work limit bounds.
  const takers = [];
  const taken = []; // taken[i]: the first point where an earlier row takes part of row i
  enumerate(fires, (m, idx) => {
    let j = -1;
    for (let w = 0; w < words; w++) {
      for (let b = m[w]; b; b &= b - 1) {
        const i = w * 32 + lowest(b);
        if (j < 0) { j = i; continue; }
        (takers[i] ??= new Uint32Array(words))[j >> 5] |= 1 << (j & 31);
        taken[i] ??= idx.slice();
      }
    }
  });

  const example = at => {
    const input = {};
    paths.forEach((p, f) => { const v = domains[f][at[f]]; if (v !== undefined) set(input, p, v); });
    return input;
  };
  const errors = rows.flatMap((r, i) => has(fires, i) ? [] : [{
    row: i,
    message: `rule table ${name}: row ${i + 1} (${r.outcome}) ` +
      (has(reached, i) ? 'never fires: earlier rows match every input it matches' : 'is unreachable: it matches no input'),
  }]);

  // One warning per partly taken row. Adjacent rows on the same fields share one when each is taken by every firing
  // row from the same row on, or all by the same rows. Takers are ranges of row indices, and a run keeps only its first
  // row's, so a ladder costs one warning, not a list per row.
  const firingBefore = new Int32Array(rows.length + 1);
  rows.forEach((_, i) => { firingBefore[i + 1] = firingBefore[i] + has(fires, i); });
  const firingOn = new Map(paths.map(p => [p, []])); // the firing rows with a condition on each field, ascending
  rows.forEach((r, i) => { if (has(fires, i)) for (const p of Object.keys(r.when)) firingOn.get(p).push(i); });
  const anyIn = (list, a, b) => {
    let lo = 0;
    for (let hi = list.length; lo < hi;) { const mid = (lo + hi) >> 1; if (list[mid] < a) lo = mid + 1; else hi = mid; }
    return list[lo] <= b;
  };
  const runs = [];
  rows.forEach((r, i) => {
    if (!takers[i]) return;
    const ranges = [];
    let count = 0;
    takers[i].forEach((b, w) => {
      for (; b; b &= b - 1, count++) {
        const j = w * 32 + lowest(b);
        const last = ranges.at(-1);
        if (last?.[1] === j - 1) last[1] = j;
        else ranges.push([j, j]);
      }
    });
    const from = ranges[0][0];
    const relative = count === firingBefore[i] - firingBefore[from];
    const fields = paths.filter(p => Object.hasOwn(r.when, p) || ranges.some(([a, b]) => anyIn(firingOn.get(p), a, b))).sort();
    const setKey = JSON.stringify(ranges);
    const fieldsKey = JSON.stringify(fields);
    const run = runs.at(-1);
    if (run?.rows[1] === i - 1 && run.fieldsKey === fieldsKey) {
      if (run.mode !== 'from' && setKey === run.setKey) { run.mode = 'same'; run.rows[1] = i; return; }
      if (run.mode !== 'same' && relative && run.relative && from === run.from) { run.mode = 'from'; run.rows[1] = i; return; }
    }
    runs.push({ rows: [i, i], ranges, from, relative, setKey, fieldsKey, fields, mode: null, example: example(taken[i]) });
  });
  const named = ranges => ranges.map(([a, b]) => a === b ? `row ${a + 1}` : `rows ${a + 1}-${b + 1}`).join(', ');
  const warnings = runs.map(({ rows: [a, b], ranges, from, fields, mode, example }) => {
    const message = a === b
      ? `row ${a + 1} (${conditions(rows[a].when)}) is partly taken by ` + ranges
        .flatMap(([x, y]) => Array.from({ length: y - x + 1 }, (_, k) => `row ${x + k + 1} (${conditions(rows[x + k].when)})`))
        .join(', ')
      : `rows ${a + 1}-${b + 1} are each partly taken by ` +
        (mode === 'same' ? named(ranges) : firingBefore[from] === 0 ? 'every earlier firing row' : `every earlier firing row from row ${from + 1}`) +
        `, all on ${fields.join(', ')}`;
    return {
      rows: [a, b],
      earlier: ranges,
      from: mode === 'from' ? from : null,
      fields,
      example,
      message: `rule table ${name}: ${message}, for example ${JSON.stringify(example)}`,
    };
  });
  return { errors, warnings, defaultExample: fallen && example(fallen) };
}
