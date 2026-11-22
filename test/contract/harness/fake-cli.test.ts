// The fake CLI child any Harness's medium tests launch (#480, Q3 A), over gg's real launch and a stand-in recording
// that is neither Claude's nor Codex's (test/fixtures/stand-in-cli/): its replay, the modes that leave the result out
// or hang, the transcript it writes where it is told, and a command that is no model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cliReplay from '../../support/cli-replay.ts';

const CASE = { timeout: 120_000 };
const RECORDINGS = fileURLToPath(new URL('../../fixtures/stand-in-cli', import.meta.url));
const STAND_IN = { recordings: RECORDINGS, resultType: 'done' };
const SAID = [
  '{"type":"started","session":"stand-in-session-1"}',
  '{"type":"said","text":"working"}',
  '{"type":"done","answer":"heliotrope"}',
];

// A launch of the stand-in CLI over the fake, and the lines it printed.
async function launchOver(fake: cliReplay.FakeCli, changes: { args?: string[]; stallMs?: number } = {}) {
  const lines: string[] = [];
  const ended = await fake.launch({
    command: 'stand-in',
    args: changes.args ?? ['run', '--json'],
    cwd: fake.cwd,
    input: 'the prompt',
    wallMs: 60_000,
    ...(changes.stallMs !== undefined && { stallMs: changes.stallMs }),
    onLine: (line) => lines.push(line),
  });
  return { ended, lines };
}

test(
  "the fake replays each model call's recording in turn, with its exit code and the files it changed",
  CASE,
  async (t) => {
    const fake = cliReplay.fakeCli(t, { ...STAND_IN, scenario: ['said', 'refused'] });
    const first = await launchOver(fake);
    const second = await launchOver(fake, { args: ['run', 'again'] });
    assert.deepEqual(
      {
        first: { lines: first.lines, code: first.ended.code },
        second: { code: second.ended.code, lastLine: second.lines.at(-1) },
        made: existsSync(join(fake.cwd, 'made.txt')) ? readFileSync(join(fake.cwd, 'made.txt'), 'utf8') : null,
        calls: fake.calls().map(({ recording, argv, stdin }) => ({ recording, argv, stdin })),
      },
      {
        first: { lines: SAID, code: 0 },
        second: { code: 3, lastLine: '{"type":"refused","reason":"no key"}' },
        made: 'made by the stand-in\n',
        calls: [
          { recording: 'said', argv: ['run', '--json'], stdin: 'the prompt' },
          { recording: 'refused', argv: ['run', 'again'], stdin: 'the prompt' },
        ],
      },
    );
  },
);

test('no-result leaves out the line of the result type', CASE, async (t) => {
  const fake = cliReplay.fakeCli(t, { ...STAND_IN, scenario: 'said', mode: 'no-result' });
  const { ended, lines } = await launchOver(fake);
  assert.deepEqual({ lines, code: ended.code }, { lines: SAID.slice(0, 2), code: 0 });
});

test('a hang leaves out the result line and is ended by the stall clock', CASE, async (t) => {
  const fake = cliReplay.fakeCli(t, { ...STAND_IN, scenario: 'said', mode: 'hang' });
  const { ended, lines } = await launchOver(fake, { stallMs: 1_000 });
  assert.deepEqual({ lines, timedOut: ended.timedOut }, { lines: SAID.slice(0, 2), timedOut: 'stall' });
});

test('the fake writes the transcript where it is told, from the file it is told', CASE, async (t) => {
  const fake = cliReplay.fakeCli(t, {
    ...STAND_IN,
    scenario: 'said',
    transcript: ({ recording, home }) => ({
      path: join(home, 'sessions', 'stand-in.jsonl'),
      from: `${recording}.jsonl`,
    }),
  });
  await launchOver(fake);
  const transcript = join(fake.home, 'sessions', 'stand-in.jsonl');
  assert.equal(existsSync(transcript) ? readFileSync(transcript, 'utf8') : null, `${SAID.join('\n')}\n`);
});

test('a command that is no model call prints its recorded answer and replays nothing', CASE, async (t) => {
  const fake = cliReplay.fakeCli(t, {
    ...STAND_IN,
    scenario: 'said',
    commands: [{ argv: ['--version'], stdout: 'stand-in 1.0.0\n', exitCode: 0 }],
  });
  const { ended, lines } = await launchOver(fake, { args: ['--version'] });
  assert.deepEqual(
    { lines, code: ended.code, calls: fake.calls().length },
    { lines: ['stand-in 1.0.0'], code: 0, calls: 0 },
  );
});
