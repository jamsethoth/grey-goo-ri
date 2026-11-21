import { test } from 'node:test';
import assert from 'node:assert/strict';
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
