import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as redaction from '../../scripts/record-codex-redaction.ts';

// DoD 4 (#479): the recorder's own redaction finds nothing left in a committed Codex fixture: no checkout path, home,
// user name, token or email. The check reads the name only standing whole: Ubuntu CI runs as `runner`, a word inside
// Codex's own executable names in cli-doctor.json (CI run 45056354195), which the recorder itself would redact.
test('no Codex recording holds what the recorder redacts', () => {
  const recordings = new URL('../fixtures/codex/', import.meta.url);
  const redact = redaction.redactorOf('Z:/no-such-recording-base', { wholeName: true });
  const leaking = readdirSync(recordings).filter((file) => {
    const text = readFileSync(new URL(file, recordings), 'utf8');
    return redact(text) !== text;
  });
  assert.deepEqual(leaking, []);
});

// The recorder redacts the name wherever it appears, as scripts/record-claude.ts does (owner Q4 A, D6 A).
test('the recorder redacts the user name inside a longer name too', () => {
  const redact = redaction.redactorOf('Z:/no-such-recording-base', { username: 'runner' });
  assert.equal(
    redact('codex-command-runner.exe; runner_x; Runner said; D:/runner/x'),
    'codex-command-<user>.exe; <user>_x; <user> said; D:/<user>/x',
  );
});

test("the privacy test's check redacts the user name only standing whole", () => {
  const redact = redaction.redactorOf('Z:/no-such-recording-base', { username: 'runner', wholeName: true });
  assert.equal(
    redact('codex-command-runner.exe; runner_x; Runner said; D:/runner/x'),
    'codex-command-runner.exe; runner_x; <user> said; D:/<user>/x',
  );
});
