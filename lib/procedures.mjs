// Procedures as data: the interpreter runs these Actions; describe() is what `gg doctor` prints. An Action's `id` is unique
// in its Procedure, and each Action carries the Recovery Number of the pass it runs in.
// A PR body or comment `body` template reads the Vertex's own outputs by Action id and its inputs (W2). A PR upsert's
// optional `with` binds further names to references, so the four Procedures that render the PR body share one template
// though each finds the report and evidence in a different place.
// A `check` Action names its Check kind (`command`, `tests-fail`, `response`, `repeat`) and that kind's parameters; a
// command names a Declared Command (U13). Each Claim token is `{ requires: [<check ids>] }` or `{ stop: true }` (Q3); a
// Check no claimed token requires is a recorded fact. `recover: { max, brief }` is the Visit's recovery budget: after a
// pass in which a required Check failed in a way its kind can recover from, the agent's Session resumes with `brief` and
// each failing Check's `recoverBrief` section, then every Check runs again (T4, W1).
const RED_CHECK = { kind: 'check', check: 'tests-fail', command: 'test', names: 'response.tests', recoverBrief: 'still-green.md' };
const TEST = { kind: 'check', check: 'command', command: 'test', recoverBrief: 'test-fix.md' };
const IMPL_INPUTS = { report: 'inputs.report', red: 'inputs.red', green: 'inputs.green' };
const CLAIMS = { ok: { requires: ['test'] }, blocked: { stop: true }, misscoped: { stop: true } };
const RECOVER = { max: 1, brief: 'recover.md' };

export const PROCEDURES = {
  // Red: failing tests only, committed once the Red Check proves they fail.
  'tests-fail': {
    actions: [
      { id: 'red', phase: 'red', kind: 'call' },
      { id: 'red-check', phase: 'red', ...RED_CHECK },
      { id: 'commit', phase: 'red', kind: 'commit' },
    ],
    claims: { ...CLAIMS, ok: { requires: ['red-check'] } },
    recover: RECOVER,
    // Red writes tests, so its Checks assert no Test Immutability (R3b).
    tests: 'write',
    briefs: { red: 'red.md' },
    outcomes: ['ok', 'blocked', 'misscoped'],
    commitKinds: { red: 'test' },
  },
  // Green: the implementation on red's committed tests, which it reads from the record.
  implement: {
    actions: [
      { id: 'green', phase: 'green', kind: 'call' },
      { id: 'test', phase: 'green', ...TEST },
      { id: 'commit', phase: 'green', kind: 'commit' },
      { id: 'push', phase: 'green', kind: 'push' },
      { id: 'pr', phase: 'green', kind: 'pr-upsert', body: 'pr-body.md', with: { report: 'green.response', red: 'inputs.red', green: 'test.evidence' } },
    ],
    claims: CLAIMS,
    recover: RECOVER,
    briefs: { green: 'green.md' },
    outcomes: ['ok', 'blocked', 'misscoped'],
    commitKinds: { green: 'feat' },
  },
  // A fix Visit after a review: a fresh Session with History and the Findings, never resuming (ff lib/run.mjs:320-321).
  fix: {
    actions: [
      { id: 'fix', phase: 'fix', kind: 'call' },
      { id: 'test', phase: 'fix', ...TEST },
      { id: 'commit', phase: 'fix', kind: 'commit' },
      { id: 'push', phase: 'fix', kind: 'push' },
      { id: 'pr', phase: 'fix', kind: 'pr-upsert', body: 'pr-body.md', with: { report: 'fix.response', red: 'inputs.red', green: 'test.evidence' } },
    ],
    claims: CLAIMS,
    recover: RECOVER,
    // The tests the fix may change: those its review's Findings name (T8).
    tests: { named: 'inputs.testFiles' },
    briefs: { fix: 'fix.md' },
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
      { id: 'comment', phase: 'review', kind: 'comment', body: 'review-comment.md' },
      { id: 'pr', phase: 'review', kind: 'pr-upsert', body: 'pr-body.md', with: IMPL_INPUTS },
    ],
    claims: { ok: { requires: [] }, changes: { requires: [] }, misscoped: { stop: true } },
    passed: [{ when: { claim: 'ok', 'check.review-pass': 'passed' }, outcome: 'ok' }],
    otherwise: 'changes',
    access: 'read-only',
    briefs: { review: 'review.md' },
    outcomes: ['ok', 'changes', 'repeat', 'misscoped'],
  },
  // Publishing, with no agent Action and so the implicit Claim ok (R11f): the test command again on the reviewed work,
  // whichever Vertex ran before (R11d), the PR body re-rendered, and pr-ready on the commit that Check passed (T1a, T2).
  publish: {
    actions: [
      { id: 'test', phase: 'publish', ...TEST },
      { id: 'pr', phase: 'publish', kind: 'pr-upsert', body: 'pr-body.md', with: IMPL_INPUTS },
      { id: 'pr-ready', phase: 'publish', kind: 'pr-ready', requires: 'test' },
    ],
    briefs: {},
    outcomes: ['ok'],
  },
};

// A Procedure with no agent Action has the implicit Claim ok, which requires every Check it declares (R11f).
export function describe(name) {
  const p = PROCEDURES[name];
  const checks = p.actions.filter((a) => a.kind === 'check').map((a) => a.id);
  return { actions: p.actions, claims: p.claims ?? { ok: { requires: checks } } };
}
