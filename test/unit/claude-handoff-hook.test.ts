import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as claudeHandoffHook from '../../lib/harnesses/claude-handoff-hook.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// The hand-off hook (#430, after the gg-ticket plugin's hooks/gg-context-cap.mjs): what it says to an agent whose
// latest request sent a context past its contextBudget.

const BUDGET = 150000;

// A transcript as Claude Code writes one, an assistant entry for each request with the context it sent split as the
// API reports it, and the hook input a PostToolUse after a Read sends with it.
function hookInput(t: TestContext, ...contexts: number[]) {
  const directory = tempDirectory.tempDirectory(t, 'gg-handoff-hook-');
  const transcriptPath = join(directory, 'session-1.jsonl');
  const entry = (context: number) => ({
    type: 'assistant',
    message: {
      usage: { input_tokens: 10, cache_read_input_tokens: context - 1010, cache_creation_input_tokens: 1000 },
    },
  });
  writeFileSync(transcriptPath, `${contexts.map((context) => JSON.stringify(entry(context))).join('\n')}\n`);
  const input = {
    session_id: 'session-1',
    transcript_path: transcriptPath,
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
  };
  return { input, stateDirectory: join(directory, 'state') };
}

// What the hook's stdout tells Claude to add to the agent's context.
const addedContext = (stdout: string | null) => {
  assert.ok(stdout !== null, 'the hook says something');
  const said = JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
  assert.equal(said.hookSpecificOutput?.hookEventName, 'PostToolUse', stdout);
  return said.hookSpecificOutput.additionalContext ?? '';
};

test('under its contextBudget the hand-off hook says nothing', (t) => {
  const { input, stateDirectory } = hookInput(t, 149000);
  assert.equal(claudeHandoffHook.respond(input, { budget: BUDGET, stateDirectory }), null);
});

test('past its contextBudget the hand-off hook asks for the handed-off Claim with a note of what remains', (t) => {
  const { input, stateDirectory } = hookInput(t, 151000);
  const text = addedContext(claudeHandoffHook.respond(input, { budget: BUDGET, stateDirectory }));
  assert.ok(text.includes('"handed-off"'), `it names the Claim token: ${text}`);
  assert.ok(text.includes('"handoff"'), `it names the note field: ${text}`);
  assert.ok(text.includes('151k') && text.includes('150k'), `it gives the context and the budget: ${text}`);
});

// A compaction or a smaller request lowers the context: the latest request decides, not the largest.
test('the hand-off hook reads the context of the latest request', (t) => {
  const { input, stateDirectory } = hookInput(t, 160000, 140000);
  assert.equal(claudeHandoffHook.respond(input, { budget: BUDGET, stateDirectory }), null);
});

test('the hand-off hook asks once in each 40,000 tokens past the budget', (t) => {
  const first = hookInput(t, 155000);
  const options = { budget: BUDGET, stateDirectory: first.stateDirectory };
  assert.ok(addedContext(claudeHandoffHook.respond(first.input, options)).includes('155k'));
  const sameStep = { ...first.input, transcript_path: hookInput(t, 189000).input.transcript_path };
  assert.equal(claudeHandoffHook.respond(sameStep, options), null, 'not again within the same step');
  const nextStep = { ...first.input, transcript_path: hookInput(t, 191000).input.transcript_path };
  assert.ok(addedContext(claudeHandoffHook.respond(nextStep, options)).includes('191k'), 'again a step later');
});

// A hook that fails would break the tool call it follows, so one that cannot read its transcript stays silent.
test('a hand-off hook whose transcript is missing says nothing', (t) => {
  const { input, stateDirectory } = hookInput(t, 151000);
  const missing = { ...input, transcript_path: join(stateDirectory, 'no-such-session.jsonl') };
  assert.equal(claudeHandoffHook.respond(missing, { budget: BUDGET, stateDirectory }), null);
});

// Claude may still be writing the transcript's last line when the hook reads it (#430 D4 A).
test('the hand-off hook skips a partly written last line to the latest complete request', (t) => {
  const { input, stateDirectory } = hookInput(t, 151000);
  writeFileSync(input.transcript_path, '{"type":"assistant","message":{"usa', { flag: 'a' });
  assert.ok(addedContext(claudeHandoffHook.respond(input, { budget: BUDGET, stateDirectory })).includes('151k'));
});
