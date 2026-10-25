import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as interpreter from '../lib/interpreter.mjs';
import * as reconcile from '../lib/reconcile.mjs';
import * as record from '../lib/record.mjs';
import * as golden from './support/golden.mjs';
import {
  stepsOf, remoteSha, loadTicket, EFFECTS, POINTS, crashed, NEEDS_HUMAN, reconcileArgs,
} from './support/reconcile.mjs';

test('an amended commit with the marker holds the ticket', async (t) => {
  const g = await golden.setup(t, { git: 'real', git: 'real' });
  const { m } = await crashed(g, EFFECTS.commit.at, 'after-effect');
  // A human amends the gg commit between the crash and the resume: same marker and parent, different tree.
  writeFileSync(join(g.worktree, 'lib', 'extra.mjs'), 'export const extra = 1;\n');
  golden.sh(g.worktree, 'add', 'lib/extra.mjs');
  golden.sh(g.worktree, 'commit', '-q', '--amend', '--no-edit');
  writeFileSync(join(g.worktree, 'notes.txt'), 'a human note\n');
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');
  const status = golden.sh(g.worktree, 'status', '--porcelain');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason.includes(m), `the reason names the marker: ${decided.reason}`);

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  const final = await loadTicket(g);
  assert.equal(final.state, 'held');
  assert.ok(g.gh.labels.has(NEEDS_HUMAN), 'the ticket is labelled needs-human');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(golden.sh(g.worktree, 'status', '--porcelain'), status, 'nothing is discarded');
  assert.ok(existsSync(join(g.worktree, 'notes.txt')));
  assert.equal(remoteSha(g), null, 'nothing is pushed');
  assert.equal(g.harness.calls.length, 2);
});

test('a commit amended after its completion was saved holds the ticket', async (t) => {
  const g = await golden.setup(t, { git: 'real', git: 'real' });
  const { m } = await crashed(g, EFFECTS.commit.at, 'after-completion');
  // The commit is complete in the record, so no open intent points at it; the amend keeps its marker.
  writeFileSync(join(g.worktree, 'lib', 'extra.mjs'), 'export const extra = 1;\n');
  golden.sh(g.worktree, 'add', 'lib/extra.mjs');
  golden.sh(g.worktree, 'commit', '-q', '--amend', '--no-edit');
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason.includes(m), `the reason names the marker: ${decided.reason}`);

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'held');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(remoteSha(g), null, 'the amended commit is not published');
  assert.equal(g.harness.calls.length, 2);
});

test('a crash before the commit replays the intended tree, not a human edit', async (t) => {
  const g = await golden.setup(t, { git: 'real', git: 'real' });
  const { m } = await crashed(g, EFFECTS.commit.at, 'before-effect');
  writeFileSync(join(g.worktree, 'notes.txt'), 'a human note\n');

  const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal(result.outcome, 'done');
  const final = await loadTicket(g);
  const { payload } = final.log.find((e) => e.marker === m && e.step === 'intent');
  const { sha } = final.log.find((e) => e.marker === m && e.step === 'evidence').evidence;
  assert.equal(golden.sh(g.worktree, 'rev-parse', `${sha}^{tree}`), payload.tree, 'the commit has the intended tree');
  assert.equal(golden.sh(g.worktree, 'rev-parse', `${sha}^`), payload.parent, 'and the intended parent');
  assert.equal(readFileSync(join(g.worktree, 'notes.txt'), 'utf8'), 'a human note\n', 'the human edit is kept');
  assert.match(golden.sh(g.worktree, 'status', '--porcelain'), /\?\? notes\.txt/, 'and left uncommitted');
});

test('a branch moved before the commit replay holds the ticket', async (t) => {
  const g = await golden.setup(t, { git: 'real', git: 'real' });
  const { m } = await crashed(g, EFFECTS.commit.at, 'before-effect');
  golden.sh(g.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');
  const head = golden.sh(g.worktree, 'rev-parse', 'HEAD');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason.includes(m), decided.reason);

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'held');
  assert.equal(golden.sh(g.worktree, 'rev-parse', 'HEAD'), head, 'nothing is committed');
  assert.equal(remoteSha(g), null, 'nothing is pushed');
});

test('a branch moved before the push replay holds the ticket', async (t) => {
  const g = await golden.setup(t, { git: 'real', git: 'real' });
  const { m } = await crashed(g, EFFECTS.push.at, 'before-effect');
  golden.sh(g.worktree, 'commit', '-q', '--allow-empty', '-m', 'a human commit');

  const decided = await reconcile.reconcile(reconcileArgs(g, await loadTicket(g)));
  assert.equal(decided.next, 'hold');
  assert.ok(decided.reason.includes(m), decided.reason);

  await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
  assert.equal((await loadTicket(g)).state, 'held');
  assert.equal(remoteSha(g), null, 'the moved branch is not published');
});

// A misscoped green ends in replan, whose Terminal posts the diagnosis on the ticket (ordinal 1) and the epic (ordinal 2).
const DIAGNOSIS = 'The ticket asks add to both sum and concatenate.';
for (const point of Object.keys(POINTS)) {
  test(`a crash ${point} of the epic diagnosis comment resumes the same replan Actions`, async (t) => {
    const g = await golden.setup(t, { responses: { ...structuredClone(golden.firstVisitResponses),
      'implementer/1/green/1': { files: {}, response: { ...golden.greenResponse, claim: 'misscoped', diagnosis: DIAGNOSIS } } } });
    await crashed(g, ['replan', 1, 'replan', 2], point);

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, 'replan');
    const onEpic = g.gh.comments.filter((c) => c.target === 'issue' && c.number === g.rec.epic);
    assert.equal(onEpic.length, 1, 'exactly one diagnosis on the epic');
    assert.ok(onEpic[0].body.includes(DIAGNOSIS));
    const onTicket = g.gh.comments.filter((c) => c.target === 'issue' && c.number === golden.TICKET);
    assert.equal(onTicket.length, 1);
    assert.ok(onTicket[0].body.includes(DIAGNOSIS));
    assert.ok(g.gh.labels.has('gg:state:needs-replan'), 'the label Action keeps its own payload');
    const final = await loadTicket(g);
    assert.equal(final.state, 'replan');
    for (const e of final.log.filter((x) => x.step === 'intent')) {
      assert.deepEqual(stepsOf(final, e.marker), ['intent', 'evidence', 'complete'], `${e.action} ${e.marker}`);
    }
  });
}

// The red call writes a Protected File, an Integrity Violation: the worktree is rolled back and the ticket goes to needs-human.
// On the fake integrity the write is only scripted, for a test whose subject is what follows the violation.
async function violating(t, integrity = 'real') {
  const g = await golden.setup(t, { integrity });
  const run = g.harness.run;
  g.harness.run = async (call) => {
    const out = await run(call);
    if (call.phase === 'red' && g.fake) g.fake.write(g.worktree, 'CLAUDE.md');
    else if (call.phase === 'red') writeFileSync(join(g.worktree, 'CLAUDE.md'), 'an agent edit\n');
    return out;
  };
  return g;
}

// Before the effect the worktree is still as the violating call left it, so the record proves the rollback the agent's.
for (const point of ['before-effect', 'after-effect', 'after-completion']) {
  test(`a crash ${point} of an integrity violation rollback does not call the harness again`, async (t) => {
    const g = await violating(t);
    // The rollback's own marker: the ordinal after red's three declared Actions.
    await crashed(g, ['implementer', 1, 'red', 4], point);
    assert.equal(g.harness.calls.length, 1);

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, 'needs-human');
    assert.equal(g.harness.calls.length, 1, 'the violating call is not dispatched again');
    const final = await loadTicket(g);
    assert.equal(final.state, 'needs-human');
    assert.equal(final.terminalReason.rule, 'integrity-violation');
    assert.equal(final.history.filter((h) => h.kind === 'integrity violation').length, 1);
    assert.ok(!existsSync(join(g.worktree, 'CLAUDE.md')), 'the violation stays rolled back');
  });
}

for (const point of ['after-effect', 'after-completion']) {
  test(`a crash ${point} of gg's own needs-human label finishes the Terminal`, async (t) => {
    const g = await violating(t, 'fake');
    await crashed(g, ['needs-human', 1, 'needs-human', 2], point);
    assert.ok(g.gh.labels.has(NEEDS_HUMAN), 'gg applied the label before the crash');

    const result = await interpreter.runExecution({ ...g.options, record: await loadTicket(g) });
    assert.equal(result.outcome, 'needs-human');
    const final = await loadTicket(g);
    assert.equal(final.state, 'needs-human', 'not mistaken for a human override');
    assert.deepEqual(record.openIntents(final), []);
    assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
  });
}

// GitHub keeps the repository's spelling of a label gg adds, and the prefix's case may change between Runs.
for (const point of ['after-effect', 'after-completion']) {
  test(`gg-owned mixed-case needs-human completes without abandonment or replay, crash ${point}`, async (t) => {
    const g = await violating(t, 'fake');
    const spelled = 'Gg:state:needs-human';
    g.gh = golden.fakeGh({ branch: golden.BRANCH, repoLabels: [spelled] });
    g.options.gh.setGh(g.gh.gh);
    const edits = () => g.gh.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'edit').length;
    await crashed(g, ['needs-human', 1, 'needs-human', 2], point);
    assert.deepEqual([...g.gh.labels], [spelled], 'GitHub shows the repository spelling');
    assert.equal(edits(), 1);

    const result = await interpreter.runExecution({ ...g.options, labelPrefix: 'Gg', record: await loadTicket(g) });
    assert.equal(result.outcome, 'needs-human');
    const final = await loadTicket(g);
    assert.equal(final.state, 'needs-human', 'not mistaken for a human override');
    assert.deepEqual(record.openIntents(final), []);
    assert.equal(edits(), 1, 'the label is not applied again');
    assert.equal(g.readEvents().filter((e) => e.type === 'ticket_end').length, 1);
  });
}

test('label reconciliation requires case-insensitive additions and removals', async (t) => {
  const g = await violating(t, 'fake');
  const { m } = await crashed(g, ['needs-human', 1, 'needs-human', 2], 'after-effect');
  const edits = () => g.gh.calls.filter((c) => c.args[0] === 'issue' && c.args[1] === 'edit').length;
  const before = edits();
  const shows = async (names) => {
    g.gh.labels.clear();
    for (const name of names) g.gh.labels.add(name);
    const rec = await loadTicket(g);
    assert.equal((await reconcile.terminalEffects(rec, { gh: g.options.gh, labelPrefix: 'gg', cwd: g.mainRoot, markers: [m] })).next, 'continue');
    // A found effect has its evidence saved; the interpreter completes it with its Event.
    return (await loadTicket(g)).log.some((e) => e.marker === m && e.step === 'evidence');
  };
  assert.equal(await shows([NEEDS_HUMAN, 'GG:STATE:IN-PROGRESS']), false, 'a removal still shown differently cased stays open');
  assert.equal(await shows([]), false, 'an absent addition stays open');
  assert.equal(await shows(['GG:State:Needs-Human']), true, 'a differently cased addition with the removal absent completes');
  assert.equal(edits(), before, 'Reconciliation makes no label edit');
});
