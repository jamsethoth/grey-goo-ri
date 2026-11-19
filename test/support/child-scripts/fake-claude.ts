// The claude CLI as the Claude Harness launches it, replaying one recorded call (test/fixtures/claude/<scenario>.jsonl)
// on stdout, with the recording's exit code. It reads its stdin to the end first, writes what it received (argv and
// stdin) to FAKE_CLAUDE_RECEIVED, and writes the transcript where Claude Code does: under CLAUDE_CONFIG_DIR, in
// projects/<cwd, each non-alphanumeric character as "-">/<session id>.jsonl. FAKE_CLAUDE_MODE changes the replay:
// `no-result` leaves out the result line, `garbage` sends a line that is not JSON after the init line, and `hang` leaves
// out the result line and then outlives any case, so only a kill ends it.
// The test runner also loads this file with no FAKE_CLAUDE_SCENARIO, where it does nothing.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as childScripts from '../child-scripts.ts';

const scenario = process.env.FAKE_CLAUDE_SCENARIO;
if (scenario) await replay(scenario, process.env.FAKE_CLAUDE_MODE ?? 'replay');

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
  if (configDirectory) {
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
  }[mode];
  if (!sent) throw new Error(`fake claude has no mode ${mode}`);
  process.stdout.write(sent.map((line) => `${line}\n`).join(''));
  if (mode === 'hang') setTimeout(() => {}, childScripts.LIVES_MS);
  else process.exitCode = exitCode;
}
