// Rule Tables: first-match evaluation and exact analysis over the table's finite domain partition (R8, V5, N2).

// Measured in #103: 9.4 million row checks took 0.17 s and the example's review table 1 ms, so an admission stays
// under a second unless it holds more than about five tables near the limit.
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
  if (cond !== null && typeof cond === 'object') return Number.isInteger(v) && Object.entries(cond).every(([op, c]) => OPS[op](v, c));
  return v === cond;
}

export function evaluate(table, input) {
  const i = table.rows.findIndex(row => Object.entries(row.when).every(([path, cond]) => matches(cond, get(input, path))));
  return i < 0 ? null : i;
}

// One value per equivalence class: every constant and its neighbours represent the intervals between and outside them.
function partition(spec, conds) {
  let values;
  if (spec.enum) values = [...spec.enum];
  else if (spec.type === 'boolean') values = [true, false];
  else {
    const cuts = new Set([spec.minimum, spec.maximum].filter(Number.isInteger));
    for (const cond of conds) for (const c of typeof cond === 'object' ? Object.values(cond) : [cond]) cuts.add(beside(c, -1)).add(c).add(beside(c, 1));
    values = [...cuts].filter(v => Number.isFinite(v) && !(v < spec.minimum) && !(v > spec.maximum)).sort((a, b) => a - b);
  }
  if (spec.optional) values.push(undefined);
  return values;
}

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

  // Second pass, over firing rows only: the first point where each pair of them overlaps.
  const seen = []; // seen[i]: the earlier rows already found matching with row i
  const overlaps = [];
  enumerate(fires, (m, idx) => {
    let first = true;
    for (let w = 0; w < words; w++) {
      for (let b = m[w]; b; b &= b - 1) {
        if (first) { first = false; continue; }
        const i = w * 32 + lowest(b);
        const s = seen[i] ??= new Uint32Array(w + 1);
        for (let v = 0; v <= w; v++) {
          for (let fresh = m[v] & ~s[v]; fresh; fresh &= fresh - 1) {
            const j = v * 32 + lowest(fresh);
            if (j >= i) break;
            overlaps.push([j, i, idx.slice()]);
          }
          s[v] |= m[v];
        }
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
  const warnings = overlaps
    .sort((a, b) => a[1] - b[1] || a[0] - b[0])
    .map(([earlier, row, at]) => {
      const input = example(at);
      return { row, earlier, example: input, message: `rule table ${name}: row ${earlier + 1} wins over row ${row + 1} for ${JSON.stringify(input)}` };
    });
  return { errors, warnings, defaultExample: fallen && example(fallen) };
}
