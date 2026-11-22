import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as label from '../../lib/effects/label.ts';
import * as record from '../../lib/record.ts';
import * as writeAhead from '../../lib/write-ahead.ts';
import * as support from '../support/execution-context.ts';
import * as payloadReads from '../support/payload-reads.ts';

test("findEntry finds a marker's write-ahead entry by its step", async (t) => {
  const { executionRecord } = await support.executionContext(t);
  record.intent(executionRecord, 'gg:m', 'push', { branch: 'b', sha: 'abc' });
  assert.deepEqual(writeAhead.findEntry(executionRecord, 'gg:m', 'intent')?.payload, { branch: 'b', sha: 'abc' });
  assert.equal(writeAhead.findEntry(executionRecord, 'gg:m', 'complete'), undefined);
  assert.equal(writeAhead.findEntry(executionRecord, 'gg:other', 'intent'), undefined);
});

test("an agent call's payload reader reads its own intent's payload and refuses each Effect's by its path", () => {
  assert.ok(
    payloadReads.INTENTS.some(({ effect }) => effect === 'call'),
    'the fixture holds an agent call intent',
  );
  assert.deepEqual(payloadReads.misreads('call', writeAhead.readCallPayload), []);
});

// review-r1 (#384): record.md lets a consumed Decision's actor be absent; its payload, loaded, reads again at each use.
test("an entry's payload reads again at use as it loaded, an actor-less Consumption's too", () => {
  const consumption = payloadReads.INTENTS.find(
    ({ payload }) => typeof payload === 'object' && payload !== null && 'decision' in payload,
  );
  assert.ok(consumption, 'the fixture holds a consumed Decision');
  const { actor: _, ...decision } = (consumption.payload as { decision: Record<string, unknown> }).decision;
  const saved = { ...(consumption.payload as object), decision };
  const loaded = label.readPayload({ value: saved, path: 'writeAheadLog[0].payload' }) as writeAhead.Payload;
  const written = { ...saved, decision: { ...decision, actor: undefined } } as writeAhead.Payload;
  for (const payload of [loaded, written]) {
    const entry = writeAhead.entryOf('intent', 'gg:m', 'label', { payload });
    assert.deepEqual(JSON.stringify(writeAhead.payloadOf(entry, label.readConsumption)), JSON.stringify(saved));
    assert.deepEqual(JSON.stringify(writeAhead.payloadOf(entry, label.readPayload)), JSON.stringify(saved));
    assert.equal(label.intendsToAdd({ writeAheadLog: [entry] }, 'gg:any'), false);
  }
});
