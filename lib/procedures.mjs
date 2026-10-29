// Procedures as data: the interpreter runs these Actions; describe() is what `gg doctor` prints. An Action's `id` is unique
// in its Procedure but for the recovery Phase's Actions, which repeat it under the Recovery Number of their pass; an Action
// after the passes carries the Visit's Recovery Number.
// A `with` binds each name a comment or PR body template reads to a reference (W2): the Vertex's own outputs by Action
// id, or its inputs. A reviewer and publish render the report and evidence the implementing Vertex produced.
// A `check` Action names its Check kind (`command`, `tests-fail`, `response`, `repeat`) and that kind's parameters; a
// command names a Declared Command (U13). `requires` lists the Checks a Claim ok needs; any other is a recorded fact. A
// recovery Phase's Actions run `when` the Check they `recover` failed in a way its kind can recover from (T4c).
const RED_CHECK = { kind: 'check', check: 'tests-fail', command: 'test', names: 'response.tests' };
const TEST = { kind: 'check', check: 'command', command: 'test' };
const IMPL_INPUTS = { report: 'inputs.report', red: 'inputs.red', green: 'inputs.green' };

export const PROCEDURES = {
  // Red: failing tests only, committed once the Red Check proves they fail.
  'tests-fail': {
    actions: [
      { id: 'red', phase: 'red', recovery: 0, kind: 'call' },
      { id: 'red-check', phase: 'red', recovery: 0, ...RED_CHECK },
      { id: 'red', phase: 'still-green', recovery: 1, kind: 'call', when: { recover: 'red-check' } },
      { id: 'red-check', phase: 'still-green', recovery: 1, ...RED_CHECK, when: { recover: 'red-check' } },
      { id: 'commit', phase: 'red', kind: 'commit' },
    ],
    options: { stillGreen: 1 },
    requires: ['red-check'],
    // Red writes tests, so its Checks assert no Test Immutability (R3b).
    tests: 'write',
    // The retry-count option for each recovery Phase; a count of 0 drops that Phase's Actions.
    recovery: { 'still-green': 'stillGreen' },
    briefs: { red: 'red.md', 'still-green': 'still-green.md' },
    // The Phase each Phase resumes, null for fresh.
    lineage: { red: null, 'still-green': 'red' },
    claims: ['ok', 'blocked', 'misscoped'],
    outcomes: ['ok', 'blocked', 'misscoped'],
    commitKinds: { red: 'test' },
  },
  // Green: the implementation on red's committed tests, which it reads from the record.
  implement: {
    actions: [
      { id: 'green', phase: 'green', recovery: 0, kind: 'call' },
      { id: 'test', phase: 'green', recovery: 0, ...TEST },
      { id: 'green', phase: 'test-fix', recovery: 1, kind: 'call', when: { recover: 'test' } },
      { id: 'test', phase: 'test-fix', recovery: 1, ...TEST, when: { recover: 'test' } },
      { id: 'commit', phase: 'green', kind: 'commit' },
      { id: 'push', phase: 'green', kind: 'push' },
      { id: 'pr', phase: 'green', kind: 'pr-upsert', with: { report: 'green.response', red: 'inputs.red', green: 'test.evidence' } },
    ],
    options: { testFix: 1, requireTestPass: true },
    requires: ['test'],
    relaxable: { test: 'requireTestPass' },
    recovery: { 'test-fix': 'testFix' },
    briefs: { green: 'green.md', 'test-fix': 'test-fix.md' },
    lineage: { green: null, 'test-fix': 'green' },
    claims: ['ok', 'blocked', 'misscoped'],
    outcomes: ['ok', 'blocked', 'misscoped'],
    commitKinds: { green: 'feat' },
  },
  // A fix Visit after a review: a fresh Session with History and the Findings, never resuming (ff lib/run.mjs:320-321).
  fix: {
    actions: [
      { id: 'fix', phase: 'fix', recovery: 0, kind: 'call' },
      { id: 'test', phase: 'fix', recovery: 0, ...TEST },
      { id: 'fix', phase: 'test-fix', recovery: 1, kind: 'call', when: { recover: 'test' } },
      { id: 'test', phase: 'test-fix', recovery: 1, ...TEST, when: { recover: 'test' } },
      { id: 'commit', phase: 'fix', kind: 'commit' },
      { id: 'push', phase: 'fix', kind: 'push' },
      { id: 'pr', phase: 'fix', kind: 'pr-upsert', with: { report: 'fix.response', red: 'inputs.red', green: 'test.evidence' } },
    ],
    options: { testFix: 1, requireTestPass: true },
    requires: ['test'],
    // The tests the fix may change: those its review's Findings name (T8).
    tests: { named: 'inputs.testFiles' },
    relaxable: { test: 'requireTestPass' },
    recovery: { 'test-fix': 'testFix' },
    briefs: { fix: 'fix.md', 'test-fix': 'test-fix.md' },
    lineage: { fix: null, 'test-fix': 'fix' },
    claims: ['ok', 'blocked', 'misscoped'],
    outcomes: ['ok', 'blocked', 'misscoped'],
    commitKinds: { fix: 'fix' },
  },
  // No Claim requires a Check, so the comment and PR update always run; the `passed` table decides the Outcome, and its
  // first row is the only way to ok (P5a). A claim ok that fails review-pass routes as changes.
  review: {
    actions: [
      { id: 'review', phase: 'review', kind: 'call' },
      { id: 'review-pass', phase: 'review', kind: 'check', check: 'response', 'all-of': [
        { field: 'dodMet', is: true },
        { field: 'tddEvidenceOk', is: true },
        { none: 'findings', where: { severity: ['blocker', 'major'] } },
      ] },
      // Failed means the findings repeat an earlier review's by this Vertex (R4c): a fact, required by nothing.
      // shortcut: repeat is recorded but not routed until repeat routing lands (#117).
      { id: 'repeat', phase: 'review', kind: 'check', check: 'repeat', list: 'response.findings', fields: ['file', 'severity', 'issue'] },
      { id: 'comment', phase: 'review', kind: 'comment', with: { review: 'review.response' } },
      { id: 'pr', phase: 'review', kind: 'pr-upsert', with: IMPL_INPUTS },
    ],
    options: {},
    requires: [],
    passed: [{ when: { claim: 'ok', 'check.review-pass': 'passed' }, outcome: 'ok' }],
    otherwise: 'changes',
    access: 'read-only',
    briefs: { review: 'review.md' },
    lineage: { review: null },
    claims: ['ok', 'changes', 'misscoped'],
    outcomes: ['ok', 'changes', 'repeat', 'misscoped'],
  },
  // Publishing, with no agent Action and so the implicit Claim ok (R11f): the test command again on the reviewed work,
  // whichever Vertex ran before (R11d), the PR body re-rendered, and pr-ready on the commit that Check passed (T1a, T2).
  publish: {
    actions: [
      { id: 'test', phase: 'publish', ...TEST },
      { id: 'pr', phase: 'publish', kind: 'pr-upsert', with: IMPL_INPUTS },
      { id: 'pr-ready', phase: 'publish', kind: 'pr-ready', requires: 'test' },
    ],
    options: {},
    requires: ['test'],
    briefs: {},
    lineage: {},
    claims: ['ok'],
    outcomes: ['ok'],
  },
};

export function describe(name, options = {}) {
  const p = PROCEDURES[name];
  const o = { ...p.options, ...options };
  return {
    actions: p.actions.filter((a) => o[p.recovery?.[a.phase]] !== 0),
    // A relaxed Check (requireTestPass false) is no longer required.
    requires: p.requires.filter((id) => !(p.relaxable?.[id] && !o[p.relaxable[id]])),
    lineage: { ...p.lineage },
  };
}
