// Procedures as data: the interpreter runs these Actions; describe() is what `gg doctor` prints. An Action's `id` is unique
// in its Procedure but for the recovery Phase's Actions, which repeat it under the Recovery Number of their pass; an Action
// after the passes carries the Visit's Recovery Number.
export const PROCEDURES = {
  // Red: failing tests only, committed once the Red Check proves they fail.
  'tests-fail': {
    actions: [
      { id: 'red', phase: 'red', recovery: 0, kind: 'call' },
      { id: 'red-check', phase: 'red', recovery: 0, kind: 'check', check: 'red' },
      { id: 'red', phase: 'still-green', recovery: 1, kind: 'call', when: 'red run passed' },
      { id: 'red-check', phase: 'still-green', recovery: 1, kind: 'check', check: 'red', when: 'red run passed' },
      { id: 'commit', phase: 'red', kind: 'commit' },
    ],
    options: { stillGreen: 1 },
    checks: ['red'],
    // The retry-count option for each recovery Phase; a count of 0 drops that Phase's Actions.
    recovery: { 'still-green': 'stillGreen' },
    briefs: { red: 'red.md', 'still-green': 'still-green.md' },
    // The Phase each Phase resumes, null for fresh.
    lineage: { red: null, 'still-green': 'red' },
    claims: ['ok', 'blocked', 'misscoped'],
    outcomes: ['ok', 'blocked', 'misscoped', 'red-failed'],
    checkOutcome: { red: 'red-failed' },
    commitKinds: { red: 'test' },
  },
  // Green: the implementation on red's committed tests, which it reads from the record.
  implement: {
    actions: [
      { id: 'green', phase: 'green', recovery: 0, kind: 'call' },
      { id: 'test', phase: 'green', recovery: 0, kind: 'check', check: 'green' },
      { id: 'green', phase: 'test-fix', recovery: 1, kind: 'call', when: 'green run failed' },
      { id: 'test', phase: 'test-fix', recovery: 1, kind: 'check', check: 'green', when: 'green run failed' },
      { id: 'commit', phase: 'green', kind: 'commit' },
      { id: 'push', phase: 'green', kind: 'push' },
      { id: 'pr', phase: 'green', kind: 'pr-upsert' },
    ],
    options: { testFix: 1, requireTestPass: true },
    checks: ['immutability', 'green'],
    relaxable: { green: 'requireTestPass' },
    recovery: { 'test-fix': 'testFix' },
    briefs: { green: 'green.md', 'test-fix': 'test-fix.md' },
    lineage: { green: null, 'test-fix': 'green' },
    claims: ['ok', 'blocked', 'misscoped'],
    outcomes: ['ok', 'blocked', 'misscoped', 'gate-failed(test)'],
    checkOutcome: { test: 'gate-failed(test)' },
    commitKinds: { green: 'feat' },
  },
  // A fix Visit after a review: a fresh Session with History and the Findings, never resuming (ff lib/run.mjs:320-321).
  fix: {
    actions: [
      { id: 'fix', phase: 'fix', recovery: 0, kind: 'call' },
      { id: 'test', phase: 'fix', recovery: 0, kind: 'check', check: 'green' },
      { id: 'fix', phase: 'test-fix', recovery: 1, kind: 'call', when: 'green run failed' },
      { id: 'test', phase: 'test-fix', recovery: 1, kind: 'check', check: 'green', when: 'green run failed' },
      { id: 'commit', phase: 'fix', kind: 'commit' },
      { id: 'push', phase: 'fix', kind: 'push' },
      { id: 'pr', phase: 'fix', kind: 'pr-upsert' },
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
      { id: 'review', phase: 'review', kind: 'call' },
      { id: 'repeat', phase: 'review', kind: 'findings-hash' },
      { id: 'comment', phase: 'review', kind: 'comment' },
      { id: 'pr', phase: 'review', kind: 'pr-upsert' },
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
  // Publishing, with no agent Action and so the implicit Claim ok (R11f): the test command again on the reviewed work,
  // whichever Vertex ran before (R11d), the PR body re-rendered, and pr-ready on the commit that Check passed (T1a, T2).
  publish: {
    actions: [
      { id: 'test', phase: 'publish', kind: 'check', check: 'green' },
      { id: 'pr', phase: 'publish', kind: 'pr-upsert' },
      { id: 'pr-ready', phase: 'publish', kind: 'pr-ready', requires: 'green' },
    ],
    options: {},
    checks: ['green'],
    briefs: {},
    lineage: {},
    claims: ['ok'],
    outcomes: ['ok', 'gate-failed(test)'],
    checkOutcome: { test: 'gate-failed(test)' },
  },
};

export function describe(name, options = {}) {
  const p = PROCEDURES[name];
  const o = { ...p.options, ...options };
  return {
    actions: p.actions.filter((a) => o[p.recovery?.[a.phase]] !== 0),
    checks: p.checks.map((c) => ({ name: c, relaxed: p.relaxable?.[c] ? !o[p.relaxable[c]] : false })),
    lineage: { ...p.lineage },
  };
}
