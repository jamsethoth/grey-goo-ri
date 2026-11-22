// The claude CLI as the Claude Harness launches it, replaying one recorded call (FAKE_CLAUDE_RECORDING.jsonl) on
// stdout, with the recording's exit code. It reads its stdin to the end first, writes what it received (argv and
// stdin) to FAKE_CLAUDE_RECEIVED and its own pid to FAKE_CLAUDE_PID, and writes the transcript where Claude Code does:
// under CLAUDE_CONFIG_DIR, in projects/<cwd, each non-alphanumeric character as "-">/<session id>.jsonl.
// Before its output it writes into its working directory each file the recorded call changed (`changes`: path to
// content, null for one it deleted), so gg finds the tree as the call left it. FAKE_CLAUDE_MODE changes the replay:
// `no-result` leaves out the result line, `garbage` sends a line that is not JSON after the init line, `hang` leaves
// out the result line and then outlives any case, so only a kill ends it, `hang-no-transcript` hangs as `hang` does
// and writes no transcript, and `signal` leaves out the result line and then
// ends itself with SIGTERM. FAKE_CLAUDE_STDERR is written to stderr first. FAKE_CLAUDE_ORPHAN starts a descendant
// before the replay, through a middle process that exits once the descendant has written its pid to that file, so the
// descendant is an orphan the CLI left: detached on Windows, which keeps it out of the job libuv gives node's children;
// elsewhere in the CLI's process group, as a CLI's own children are. A command that is no model call (--version, auth
// status --json, --help) prints instead the answer FAKE_CLAUDE_COMMANDS holds for its argv (recorded-cli.ts, #427).
// Its tests copy it alone to a directory whose path holds spaces, so it imports nothing.
// The test runner also loads this file with no FAKE_CLAUDE_RECORDING, where it does nothing.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// As test/support/child-scripts.ts's LIVES_MS: longer than any case.
const LIVES_MS = 600_000;

const role = process.env.FAKE_CLAUDE_ROLE;
const orphanFile = process.env.FAKE_CLAUDE_ORPHAN;
const recording = process.env.FAKE_CLAUDE_RECORDING;
const commands = process.env.FAKE_CLAUDE_COMMANDS;
if (role === 'orphan' && orphanFile) {
  writeFileSync(orphanFile, String(process.pid));
  setTimeout(() => {}, LIVES_MS);
} else if (role === 'middle' && orphanFile) startOrphan(orphanFile);
else if (commands && !process.argv.includes('-p')) answerCommand(commands);
else if (recording) await replay(recording, process.env.FAKE_CLAUDE_MODE ?? 'replay');

function answerCommand(commandsPath: string) {
  const asked = JSON.stringify(process.argv.slice(2));
  const answers = JSON.parse(readFileSync(commandsPath, 'utf8')) as {
    argv: string[];
    stdout: string;
    exitCode: number;
  }[];
  const answered = answers.find(({ argv }) => JSON.stringify(argv) === asked);
  if (!answered) throw new Error(`fake claude has no answer for claude ${asked}`);
  process.stdout.write(answered.stdout);
  process.exitCode = answered.exitCode;
}

function startOrphan(pidFile: string) {
  spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: process.platform === 'win32',
    stdio: 'ignore',
    env: { ...process.env, FAKE_CLAUDE_ROLE: 'orphan' },
  }).unref();
  const written = setInterval(() => {
    if (existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) > 0) clearInterval(written);
  }, 20);
}

async function replay(recordingPath: string, mode: string) {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += String(chunk);
  const received = process.env.FAKE_CLAUDE_RECEIVED;
  if (received) writeFileSync(received, JSON.stringify({ argv: process.argv.slice(2), stdin }));
  if (process.env.FAKE_CLAUDE_PID) writeFileSync(process.env.FAKE_CLAUDE_PID, String(process.pid));
  if (process.env.FAKE_CLAUDE_STDERR) process.stderr.write(`${process.env.FAKE_CLAUDE_STDERR}\n`);
  if (orphanFile) {
    spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      stdio: 'ignore',
      env: { ...process.env, FAKE_CLAUDE_ROLE: 'middle' },
    });
  }
  const lines = readFileSync(`${recordingPath}.jsonl`, 'utf8').split('\n').filter(Boolean);
  const { exitCode, changes = {} } = JSON.parse(readFileSync(`${recordingPath}.json`, 'utf8')) as {
    exitCode: number;
    changes?: Record<string, string | null>;
  };
  for (const [path, text] of Object.entries(changes)) {
    if (text === null) rmSync(path, { force: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }
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
    signal: noResult,
  }[mode];
  if (!sent) throw new Error(`fake claude has no mode ${mode}`);
  process.stdout.write(
    sent.map((line) => `${line}\n`).join(''),
    () => mode === 'signal' && process.kill(process.pid, 'SIGTERM'),
  );
  if (mode.startsWith('hang')) setTimeout(() => {}, LIVES_MS);
  else if (mode !== 'signal') process.exitCode = exitCode;
}
