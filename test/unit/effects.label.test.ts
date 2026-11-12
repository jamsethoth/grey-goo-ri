import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as label from '../../lib/effects/label.ts';
import * as golden from '../support/golden.ts';
import * as effectFixture from '../support/effect-fixture.ts';

type Fixture = Awaited<ReturnType<typeof effectFixture.effectFixture>>;

const READY = 'gg:state:ready-for-qa';
const IN_PROGRESS = 'gg:state:in-progress';
const change: label.Payload = { ticket: golden.TICKET, add: [READY], remove: [IN_PROGRESS] };

// The fake gh's labels as the Ticket's issue shows them now.
const shown = (given: Fixture) => [...given.fixture.gh.labels];

// A gh whose label writes do not land, as setLabels reports one.
const failing = (given: Fixture) => ({ ...given.context, gh: { ...given.gh, setLabels: async () => false } });

test('a label write made, then looked for, is found while the issue shows it', async (t) => {
  const given = await effectFixture.effectFixture(t);
  given.fixture.gh.labels.add(IN_PROGRESS);
  assert.deepEqual(await label.recordAndGoOn.perform(given.context, change, { redo: false }), { ok: true });
  assert.deepEqual(shown(given), [READY]);
  assert.deepEqual(
    await given.lookedFor(given.intent(label.recordAndGoOn, given.markerOf('label'), change), shown(given)),
    {
      status: 'found',
      evidence: { ok: true },
    },
  );
});

// A label's finder cannot conflict: a write the issue does not show is made again.
for (const [state, labels] of [
  ['an addition the issue lacks', [IN_PROGRESS]],
  ['a removal the issue still shows', [READY, IN_PROGRESS]],
] as const) {
  test(`a label write with ${state} is absent`, async (t) => {
    const given = await effectFixture.effectFixture(t);
    assert.deepEqual(
      await given.lookedFor(given.intent(label.recordAndGoOn, given.markerOf('label'), change), [...labels]),
      {
        status: 'absent',
      },
    );
  });
}

test("a label write that does not land throws its caller's error under keep open, its intent left open", async (t) => {
  const given = await effectFixture.effectFixture(t);
  const keepOpen = label.keepOpen((payload) => new Error(`labels of #${payload.ticket} kept open`));
  await assert.rejects(keepOpen.perform(failing(given), change, { redo: false }), /labels of #15 kept open/);
});

test('a label write that does not land saves ok false under record and go on', async (t) => {
  const given = await effectFixture.effectFixture(t);
  assert.deepEqual(await label.recordAndGoOn.perform(failing(given), change, { redo: false }), { ok: false });
});

test('a label write with nothing to add or remove writes nothing and has landed', async (t) => {
  const given = await effectFixture.effectFixture(t);
  const nothing = { ticket: golden.TICKET, add: [], remove: [] };
  for (const effect of [label.recordAndGoOn, label.keepOpen(() => new Error('not written'))])
    assert.deepEqual(await effect.perform(failing(given), nothing, { redo: false }), { ok: true });
});

test('both label policies are the one label Effect, found by the same finder', () => {
  const keepOpen = label.keepOpen(() => new Error('kept open'));
  assert.equal(keepOpen.name, label.recordAndGoOn.name);
  assert.equal(keepOpen.find, label.recordAndGoOn.find);
  assert.equal(keepOpen.remote, null);
});

test("gg's own label intent that adds a label is found by the label, in any case", async (t) => {
  const given = await effectFixture.effectFixture(t);
  assert.equal(label.intendsToAdd(given.executionRecord, 'gg:state:needs-human'), false);
  given.database.intent(given.executionRecord, 'gg:label', label.recordAndGoOn.name, {
    ticket: golden.TICKET,
    add: ['GG:State:Needs-Human'],
    remove: [],
  });
  assert.equal(label.intendsToAdd(given.executionRecord, 'gg:state:needs-human'), true);
  assert.equal(label.intendsToAdd(given.executionRecord, READY), false);
});
