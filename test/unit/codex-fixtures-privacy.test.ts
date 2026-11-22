import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as redaction from '../../scripts/record-codex-redaction.ts';

// DoD 4 (#479): the recorder's own redaction finds nothing left in a committed Codex fixture: no checkout path, home,
// user name, token or email.
test('no Codex recording holds what the recorder redacts', () => {
  const recordings = new URL('../fixtures/codex/', import.meta.url);
  const redact = redaction.redactorOf('Z:/no-such-recording-base');
  const leaking = readdirSync(recordings).filter((file) => {
    const text = readFileSync(new URL(file, recordings), 'utf8');
    return redact(text) !== text;
  });
  assert.deepEqual(leaking, []);
});
