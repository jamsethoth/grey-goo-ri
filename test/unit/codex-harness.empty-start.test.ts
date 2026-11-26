import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The empty-start call replayed (#481 Q1 A, D6 A): the real call under the Codex Harness's own launch, with
// openai-developers installed in gg's Codex home, beside codex-harness.test.ts, which is at its line cap.

const text = (file: string) => readFileSync(new URL(`../fixtures/codex/${file}`, import.meta.url), 'utf8');
const recorded = JSON.parse(text('empty-start.json')) as { command: { argv: string[] }; lastMessage: string };

test('the empty start ran under a plugins table that turns every plugin off by default', () => {
  const table = recorded.command.argv.find((argument) => argument.startsWith('plugins=')) ?? '';
  assert.match(table, /^plugins=\{"_default"=\{enabled=false\},/);
  assert.match(table, /"openai-developers@openai-curated-remote"=\{enabled=false\}/);
});

// The prompt and the model's reply say "mcp__" alone; a namespace is mcp__ and its server's name.
test('no mcp__ tool namespace reaches the empty start, and the model names none', () => {
  const lines = [...text('empty-start.jsonl').split('\n'), ...text('empty-start.rollout.jsonl').split('\n')];
  assert.deepEqual(
    lines.flatMap((line) => line.match(/mcp__\w+/g) ?? []),
    [],
  );
  assert.equal((JSON.parse(recorded.lastMessage) as { answer: string }).answer.split('\n')[1], 'none');
});
