import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as codexHandoffHook from '../../lib/harnesses/codex-handoff-hook.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// Codex's hand-off hook (#485): what it says to an agent whose latest request sent a context past its contextBudget,
// read from the thread's rollout, where each request's context is its token_count event's last_token_usage.input_tokens
// (Codex's input_tokens holds its cached tokens; Clarify probe P1).

const BUDGET = 150000;

// A recorded rollout (test/fixtures/codex/<name>.rollout.jsonl): hooks-on's latest request sent 13,227 tokens;
// compaction's sent 13,216 at its peak and 13,209 last.
const recordedRollout = (name: string) =>
  fileURLToPath(new URL(`../fixtures/codex/${name}.rollout.jsonl`, import.meta.url));

// The hook input a PostToolUse sends, with the keys hooks-on's hook log shows, for the rollout at `transcriptPath`.
const hookInputFor = (transcriptPath: string) => ({
  session_id: 'thread-1',
  turn_id: 'turn-1',
  transcript_path: transcriptPath,
  cwd: 'repo',
  hook_event_name: 'PostToolUse',
  model: 'gpt-6-luna',
  permission_mode: 'bypassPermissions',
  tool_name: 'shell',
  tool_input: {},
  tool_response: {},
  tool_use_id: 'call-1',
});

// A rollout as Codex writes one, a token_count event for each request with the context it sent, and its hook input.
function hookInput(t: TestContext, ...contexts: number[]) {
  const directory = tempDirectory.tempDirectory(t, 'gg-codex-handoff-hook-');
  const transcriptPath = join(directory, 'rollout-thread-1.jsonl');
  const usage = (context: number) => ({
    input_tokens: context,
    cached_input_tokens: context - 1000,
    output_tokens: 50,
  });
  const entry = (context: number) => ({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: usage(context), last_token_usage: usage(context) } },
  });
  writeFileSync(transcriptPath, `${contexts.map((context) => JSON.stringify(entry(context))).join('\n')}\n`);
  return { input: hookInputFor(transcriptPath), stateDirectory: join(directory, 'state') };
}

// What the hook's stdout tells Codex to add to the agent's context, in the shape #479's recorded hook answered with.
const addedContext = (stdout: string | null) => {
  assert.ok(stdout !== null, 'the hook says something');
  const said = JSON.parse(stdout) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
  assert.equal(said.hookSpecificOutput?.hookEventName, 'PostToolUse', stdout);
  return said.hookSpecificOutput.additionalContext ?? '';
};

test("under its contextBudget Codex's hand-off hook says nothing", (t) => {
  const { input, stateDirectory } = hookInput(t, 149000);
  assert.equal(codexHandoffHook.respond(input, { budget: BUDGET, stateDirectory }), null);
});

test("past its contextBudget Codex's hand-off hook asks for the handed-off Claim with a note of what remains", (t) => {
  const { input, stateDirectory } = hookInput(t, 151000);
  const text = addedContext(codexHandoffHook.respond(input, { budget: BUDGET, stateDirectory }));
  assert.ok(text.includes('"handed-off"'), `it names the Claim token: ${text}`);
  assert.ok(text.includes('"handoff"'), `it names the note field: ${text}`);
  assert.ok(text.includes('151k') && text.includes('150k'), `it gives the context and the budget: ${text}`);
});

// The rollout Codex wrote on the recorded hook call, read as the hook reads it there.
test("Codex's hand-off hook reads a recorded rollout's latest request", (t) => {
  const stateDirectory = join(tempDirectory.tempDirectory(t, 'gg-codex-handoff-hook-'), 'state');
  const input = hookInputFor(recordedRollout('hooks-on'));
  assert.equal(codexHandoffHook.respond(input, { budget: 14000, stateDirectory }), null);
  assert.ok(addedContext(codexHandoffHook.respond(input, { budget: 1000, stateDirectory })).includes('13k'));
});

// A compaction lowers the context: the latest request decides, not the largest (compaction's peak 13,216, last 13,209).
test("Codex's hand-off hook reads the context of the latest request, not the peak", (t) => {
  const stateDirectory = join(tempDirectory.tempDirectory(t, 'gg-codex-handoff-hook-'), 'state');
  const input = hookInputFor(recordedRollout('compaction'));
  assert.equal(codexHandoffHook.respond(input, { budget: 13210, stateDirectory }), null);
});

test("Codex's hand-off hook asks once in each 40,000 tokens past the budget", (t) => {
  const first = hookInput(t, 155000);
  const options = { budget: BUDGET, stateDirectory: first.stateDirectory };
  assert.ok(addedContext(codexHandoffHook.respond(first.input, options)).includes('155k'));
  const sameStep = { ...first.input, transcript_path: hookInput(t, 189000).input.transcript_path };
  assert.equal(codexHandoffHook.respond(sameStep, options), null, 'not again within the same step');
  const nextStep = { ...first.input, transcript_path: hookInput(t, 191000).input.transcript_path };
  assert.ok(addedContext(codexHandoffHook.respond(nextStep, options)).includes('191k'), 'again a step later');
});

// A hook that fails would break the tool call it follows, so one that cannot read its rollout stays silent.
test('a Codex hand-off hook whose rollout is missing says nothing', (t) => {
  const { input, stateDirectory } = hookInput(t, 151000);
  const missing = { ...input, transcript_path: join(stateDirectory, 'no-such-rollout.jsonl') };
  assert.equal(codexHandoffHook.respond(missing, { budget: BUDGET, stateDirectory }), null);
});

// Codex may still be writing the rollout's last line when the hook reads it.
test("Codex's hand-off hook skips a partly written last line to the latest complete request", (t) => {
  const { input, stateDirectory } = hookInput(t, 151000);
  writeFileSync(input.transcript_path, '{"type":"event_msg","payload":{"type":"token_co', { flag: 'a' });
  assert.ok(addedContext(codexHandoffHook.respond(input, { budget: BUDGET, stateDirectory })).includes('151k'));
});
