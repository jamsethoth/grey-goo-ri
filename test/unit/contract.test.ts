// The Usage delta every Harness reports beside its Session's running total (request 3.7, #480).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as contract from '../../lib/harnesses/contract.ts';

test("a resumed call's delta is its total less the previous total", () => {
  const previous = contract.usageOf(() => 100);
  const cumulative = { ...contract.usageOf(() => 160), costUsd: 100.5 };
  assert.deepEqual(contract.usageDelta(cumulative, previous, 40), {
    inputTokens: 60,
    cacheReadTokens: 60,
    cacheWriteTokens: 60,
    outputTokens: 60,
    reasoningTokens: 60,
    costUsd: 0.5,
    // A maximum, so the call's own, not a difference.
    peakContextTokens: 40,
    turns: 60,
    toolCalls: 60,
    compactions: 60,
  });
});

test('a count the stream never reported stays null', () => {
  const cumulative = { ...contract.usageOf(() => 7), inputTokens: null, reasoningTokens: null };
  assert.deepEqual(contract.usageDelta(cumulative, null, 7), {
    inputTokens: null,
    cacheReadTokens: 7,
    cacheWriteTokens: 7,
    outputTokens: 7,
    reasoningTokens: null,
    costUsd: 7,
    peakContextTokens: 7,
    turns: 7,
    toolCalls: 7,
    compactions: 7,
  });
});
