// The claude CLI as the Claude Harness launches it, replaying one recorded call (test/fixtures/claude/<scenario>.jsonl)
// on stdout, with the recording's exit code. It reads its stdin to the end first, writes what it received (argv and
// stdin) to FAKE_CLAUDE_RECEIVED, and writes the transcript where Claude Code does: under CLAUDE_CONFIG_DIR, in
// projects/<cwd, each non-alphanumeric character as "-">/<session id>.jsonl. FAKE_CLAUDE_MODE changes the replay:
// `no-result` leaves out the result line, `garbage` sends a line that is not JSON after the init line, and `hang`
// leaves out the result line and then outlives any case, so only a kill ends it; `hang-no-transcript` hangs as `hang`
// does and writes no transcript.
// A command that is no model call (--version, auth status --json, --help) prints its recorded answer
// (recorded-cli.ts, #427) instead: `old-version` prints a version below the minimum, `logged-out` answers auth status
// as the logged-out recording; a model call under either replays as `replay` does.
// The test runner also loads this file with no FAKE_CLAUDE_SCENARIO, where it does nothing.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as childScripts from '../child-scripts.ts';
import * as recordedCli from '../recorded-cli.ts';

const COMMAND_MODES = ['old-version', 'logged-out'];
const scenario = process.env.FAKE_CLAUDE_SCENARIO;
const fakeMode = process.env.FAKE_CLAUDE_MODE ?? 'replay';
const argv = process.argv.slice(2);
if (scenario && !argv.includes('-p')) answerCommand(fakeMode);
else if (scenario) await replay(scenario, COMMAND_MODES.includes(fakeMode) ? 'replay' : fakeMode);

function answerCommand(mode: string) {
  const state = {
    loggedOut: mode === 'logged-out',
    ...(mode === 'old-version' && { version: recordedCli.OLD_VERSION }),
  };
  const { stdout, exitCode } = recordedCli.answer(argv, state);
  process.stdout.write(stdout);
  process.exitCode = exitCode;
}

async function replay(name: string, mode: string) {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += String(chunk);
  const received = process.env.FAKE_CLAUDE_RECEIVED;
  if (received) writeFileSync(received, JSON.stringify({ argv: process.argv.slice(2), stdin }));
  const recording = new URL(`../../fixtures/claude/${name}`, import.meta.url);
  const lines = readFileSync(new URL(`${recording.href}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean);
  const { exitCode } = JSON.parse(readFileSync(new URL(`${recording.href}.json`), 'utf8')) as { exitCode: number };
  const { session_id: sessionId } = JSON.parse(lines[0] ?? '{}') as { session_id: string };
  const configDirectory = process.env.CLAUDE_CONFIG_DIR;
  if (configDirectory && mode !== 'hang-no-transcript') {
    const project = join(configDirectory, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${sessionId}.jsonl`), lines.join('\n') + '\n');
  }
  const noResult = lines.filter((line) => (JSON.parse(line) as { type: string }).type !== 'result');
  const sent = {
    replay: lines,
    'no-result': noResult,
    garbage: [lines[0], 'not a JSON line', ...lines.slice(1)],
    hang: noResult,
    'hang-no-transcript': noResult,
  }[mode];
  if (!sent) throw new Error(`fake claude has no mode ${mode}`);
  process.stdout.write(sent.map((line) => `${line}\n`).join(''));
  if (mode.startsWith('hang')) setTimeout(() => {}, childScripts.LIVES_MS);
  else process.exitCode = exitCode;
}
