import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as effectErrors from '../../lib/effect-errors.ts';
import * as effects from '../../lib/effects/index.ts';
import * as prReady from '../../lib/effects/pr-ready.ts';
import * as effectFixture from '../support/effect-fixture.ts';
import * as executionContext from '../support/execution-context.ts';

type Fixture = Awaited<ReturnType<typeof effectFixture.effectFixture>>;

// The branch pushed at its head and its draft PR open: the target a pr-ready Action intends, its Check passed on the
// head's tree.
async function published(given: Fixture): Promise<prReady.Payload> {
  const sha = await given.git.headSha(given.worktree);
  await given.git.push(given.worktree, given.executionRecord.branch, sha);
  const pr = await given.gh.upsertPr(
    { branch: given.executionRecord.branch, base: 'main', title: 'T', body: 'B' },
    given.context.cwd,
  );
  return { number: pr!.number, sha, tree: await given.git.treeOf(given.worktree, sha) };
}

test('a PR whose head is the pushed commit, with the worktree clean at it, is marked ready', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const payload = await published(given);
  assert.deepEqual(await prReady.effect.perform(given.context, payload, { redo: false }), {});
  assert.equal(given.fixture.gh.pr()!.isDraft, false);
});

// Each target a PR is not marked ready at, with the Terminal Reason's clause that says why.
const UNPUBLISHABLE: [string, (given: Fixture, payload: prReady.Payload) => prReady.Payload, RegExp][] = [
  ['no pushed commit', (_f, payload) => ({ ...payload, sha: null }), /the record proves no pushed commit/],
  [
    'a Check passed on another tree',
    (_f, payload) => ({ ...payload, tree: 'e'.repeat(40) }),
    /its Check passed on tree e{40}, not on tree/,
  ],
  [
    'a worktree changed since',
    (given, payload) => {
      given.write('package.json', '{}\n');
      return payload;
    },
    /the worktree is not clean at commit/,
  ],
];
for (const [state, target, reason] of UNPUBLISHABLE) {
  test(`a PR with ${state} is held unpublished, not marked ready`, async (t) => {
    const given = await effectFixture.effectFixture(t);
    const payload = target(given, await published(given));
    const err = await executionContext.rejection(prReady.effect.perform(given.context, payload, { redo: false }));
    assert.ok(err instanceof effectErrors.EarlyTerminalError);
    assert.deepEqual([err.ending.next, (err.ending as { name?: string }).name], ['hold', 'unchecked-publish']);
    assert.match(err.ending.reason, reason);
    assert.equal(given.fixture.gh.pr()!.isDraft, true);
  });
}

test('an open pr-ready is safe to repeat: recognised, with nothing to find', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const entry = given.intent(prReady.effect, given.markerOf('ready'), await published(given));
  assert.equal(effects.recognised(prReady.effect.name), true);
  assert.deepEqual(await given.lookedFor(entry), { status: 'absent' });
});
