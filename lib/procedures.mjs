// Procedures as data: the interpreter runs these Actions; describe() is what `gg doctor` prints.
export const PROCEDURES = {
  tdd: {
    actions: [
      { phase: 'red', ordinal: 1, kind: 'call' },
      { phase: 'red', ordinal: 2, kind: 'check', check: 'red' },
      { phase: 'still-green', ordinal: 1, kind: 'call', when: 'red run passed' },
      { phase: 'still-green', ordinal: 2, kind: 'check', check: 'red', when: 'red run passed' },
      { phase: 'red', ordinal: 3, kind: 'commit' },
      { phase: 'green', ordinal: 1, kind: 'call' },
      { phase: 'green', ordinal: 2, kind: 'check', check: 'green' },
      { phase: 'test-fix', ordinal: 1, kind: 'call', when: 'green run failed' },
      { phase: 'test-fix', ordinal: 2, kind: 'check', check: 'green', when: 'green run failed' },
      { phase: 'green', ordinal: 3, kind: 'commit' },
      { phase: 'green', ordinal: 4, kind: 'push' },
      { phase: 'green', ordinal: 5, kind: 'pr-upsert' },
    ],
    options: { stillGreen: 1, testFix: 1, resumeGreen: false, requireTestPass: true },
    checks: ['red', 'immutability', 'green'],
    relaxable: { green: 'requireTestPass' },
    // The retry-count option for each recovery Phase; a count of 0 drops that Phase's Actions.
    recovery: { 'still-green': 'stillGreen', 'test-fix': 'testFix' },
    briefs: { red: 'red.md', green: 'green.md', 'still-green': 'still-green.md', 'test-fix': 'test-fix.md' },
    // The Phase each Phase resumes, null for fresh; resumeGreen makes green resume red.
    lineage: { red: null, 'still-green': 'red', green: null, 'test-fix': 'green' },
    claims: ['ok', 'blocked', 'misscoped'],
    outcomes: ['ok', 'blocked', 'misscoped', 'red-failed', 'gate-failed(test)'],
    checkOutcome: { red: 'red-failed', test: 'gate-failed(test)' },
    commitKinds: { red: 'test', green: 'feat' },
  },
  // A fix Visit after a review: a fresh Session with History and the Findings, never resuming (ff lib/run.mjs:320-321).
  fix: {
    actions: [
      { phase: 'fix', ordinal: 1, kind: 'call' },
      { phase: 'fix', ordinal: 2, kind: 'check', check: 'green' },
      { phase: 'test-fix', ordinal: 1, kind: 'call', when: 'green run failed' },
      { phase: 'test-fix', ordinal: 2, kind: 'check', check: 'green', when: 'green run failed' },
      { phase: 'fix', ordinal: 3, kind: 'commit' },
      { phase: 'fix', ordinal: 4, kind: 'push' },
      { phase: 'fix', ordinal: 5, kind: 'pr-upsert' },
    ],
    options: { testFix: 1, requireTestPass: true },
    checks: ['immutability', 'green'],
    relaxable: { green: 'requireTestPass' },
    recovery: { 'test-fix': 'testFix' },
    briefs: { fix: 'fix.md', 'test-fix': 'test-fix.md' },
    lineage: { fix: null, 'test-fix': 'fix' },
    claims: ['ok', 'blocked', 'misscoped'],
    outcomes: ['ok', 'blocked', 'misscoped', 'gate-failed(test)'],
    checkOutcome: { test: 'gate-failed(test)' },
    commitKinds: { fix: 'fix' },
  },
  // review-pass is evaluated on the Structured Response; a claim ok without evidence routes as changes.
  review: {
    actions: [
      { phase: 'review', ordinal: 1, kind: 'call' },
      { phase: 'review', ordinal: 2, kind: 'findings-hash' },
      { phase: 'review', ordinal: 3, kind: 'comment' },
      { phase: 'review', ordinal: 4, kind: 'pr-upsert' },
    ],
    options: {},
    checks: ['review-pass'],
    access: 'read-only',
    briefs: { review: 'review.md' },
    lineage: { review: null },
    claims: ['ok', 'changes', 'misscoped'],
    outcomes: ['ok', 'changes', 'repeat', 'misscoped'],
    checkOutcome: { 'review-pass': 'changes' },
  },
};

export function describe(name, options = {}) {
  const p = PROCEDURES[name];
  const o = { ...p.options, ...options };
  return {
    actions: p.actions.filter((a) => o[p.recovery?.[a.phase]] !== 0),
    checks: p.checks.map((c) => ({ name: c, relaxed: p.relaxable?.[c] ? !o[p.relaxable[c]] : false })),
    lineage: { ...p.lineage, ...(o.resumeGreen && { green: 'red' }) },
  };
}
