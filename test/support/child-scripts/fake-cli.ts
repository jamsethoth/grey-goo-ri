// An Agent CLI as a Harness launches it, replaying one recorded call (FAKE_CLI_RECORDING.jsonl) on stdout, with the
// recording's exit code; a command whose argv FAKE_CLI_COMMANDS holds prints its recorded answer instead
// (test/support/cli-replay.ts, #480). A model call reads its stdin to the end first, writes what it received (argv and
// stdin) to FAKE_CLI_RECEIVED and its own pid to FAKE_CLI_PID, and copies FAKE_CLI_TRANSCRIPT_FROM to
// FAKE_CLI_TRANSCRIPT when it is given one. Before its output it writes into its working directory each file the
// recorded call changed (`changes`: path to content, null for one it deleted), so gg finds the tree as the call left
// it. FAKE_CLI_MODE changes the replay: `no-result` leaves out each line whose `type` is FAKE_CLI_RESULT_TYPE,
// `garbage` sends a line that is not JSON after the first line, `hang` leaves out the result line and then outlives
// any case, so only a kill ends it, `hang-no-transcript` hangs as `hang` does (its launcher gives it no transcript),
// and `signal` leaves out the result line and then ends itself with SIGTERM; a hang writes its pid to FAKE_CLI_SENT
// once its lines are sent, which its launcher's clocks wait for. FAKE_CLI_STDERR is written to stderr
// first. FAKE_CLI_ORPHAN starts a descendant before the replay, through a middle process that exits once the
// descendant has written its pid to that file, so the descendant is an orphan the CLI left: detached on Windows, which
// keeps it out of the job libuv gives node's children; elsewhere in the CLI's process group, as a CLI's own children
// are. With FAKE_CLI_HELPER (a JSON argv) the descendant starts instead under a helper, a re-run of this script with
// those arguments that writes its pid to FAKE_CLI_HELPER_PID (and, ending by itself, its exit to FAKE_CLI_HELPER_EXIT)
// and stays, as a CLI's sandbox helper stays while the command it started runs (#483 Q1 A); the CLI waits for the
// descendant's pid before its replay. Its tests copy it alone to a directory whose path holds spaces, so it imports
// nothing. The test runner also loads this file with no FAKE_CLI_RECORDING, where it does nothing.
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// As test/support/child-scripts.ts's LIVES_MS: longer than any case.
const LIVES_MS = 600_000;

const role = process.env.FAKE_CLI_ROLE;
const orphanFile = process.env.FAKE_CLI_ORPHAN;
const { FAKE_CLI_HELPER: helperArgs, FAKE_CLI_HELPER_PID: helperFile, FAKE_CLI_HELPER_EXIT: helperExit } = process.env;
const recording = process.env.FAKE_CLI_RECORDING;
const answered = commandAnswer(process.env.FAKE_CLI_COMMANDS);
if (role === 'orphan' && orphanFile) {
  writeFileSync(orphanFile, String(process.pid));
  setTimeout(() => {}, LIVES_MS);
} else if (role === 'helper' && orphanFile && helperFile) {
  writeFileSync(helperFile, String(process.pid));
  // A helper that ends by itself says so; one a cleanup kills cannot, so no exit file means it stayed until cleanup.
  if (helperExit) process.on('exit', () => writeFileSync(helperExit, String(process.pid)));
  startOrphan(orphanFile);
  setTimeout(() => {}, LIVES_MS);
} else if (role === 'middle' && orphanFile) startOrphan(orphanFile);
else if (answered) {
  process.stdout.write(answered.stdout);
  process.exitCode = answered.exitCode;
} else if (recording) await replay(recording, process.env.FAKE_CLI_MODE ?? 'replay');

// The recorded answer to this argv, when it is a command that is no model call.
function commandAnswer(commandsPath: string | undefined) {
  if (!commandsPath) return undefined;
  const asked = JSON.stringify(process.argv.slice(2));
  const answers = JSON.parse(readFileSync(commandsPath, 'utf8')) as {
    argv: string[];
    stdout: string;
    exitCode: number;
  }[];
  return answers.find(({ argv }) => JSON.stringify(argv) === asked);
}

function pidWritten(pidFile: string) {
  return existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) > 0;
}

// This script re-run in `role` with `args`, detached on Windows so it outlives the process that started it.
function startDetached(role: string, args: string[] = []) {
  spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], {
    detached: process.platform === 'win32',
    stdio: 'ignore',
    env: { ...process.env, FAKE_CLI_ROLE: role },
  }).unref();
}

function startOrphan(pidFile: string) {
  startDetached('orphan');
  const written = setInterval(() => {
    if (pidWritten(pidFile)) clearInterval(written);
  }, 20);
}

async function startUnderHelper(pidFile: string, args: string[]) {
  startDetached('helper', args);
  while (!pidWritten(pidFile)) await new Promise((resolve) => setTimeout(resolve, 20));
}

// Each file the recorded call changed, written into the working directory as the call left it.
function writeChanges(changes: Record<string, string | null>) {
  for (const [path, text] of Object.entries(changes)) {
    if (text === null) rmSync(path, { force: true });
    else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
  }
}

async function replay(recordingPath: string, mode: string) {
  let stdin = '';
  for await (const chunk of process.stdin) stdin += String(chunk);
  const received = process.env.FAKE_CLI_RECEIVED;
  if (received) writeFileSync(received, JSON.stringify({ argv: process.argv.slice(2), stdin }));
  if (process.env.FAKE_CLI_PID) writeFileSync(process.env.FAKE_CLI_PID, String(process.pid));
  if (process.env.FAKE_CLI_STDERR) process.stderr.write(`${process.env.FAKE_CLI_STDERR}\n`);
  if (orphanFile && helperArgs) await startUnderHelper(orphanFile, JSON.parse(helperArgs) as string[]);
  else if (orphanFile) {
    spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      stdio: 'ignore',
      env: { ...process.env, FAKE_CLI_ROLE: 'middle' },
    });
  }
  const lines = readFileSync(`${recordingPath}.jsonl`, 'utf8').split('\n').filter(Boolean);
  const { exitCode, changes = {} } = JSON.parse(readFileSync(`${recordingPath}.json`, 'utf8')) as {
    exitCode: number;
    changes?: Record<string, string | null>;
  };
  writeChanges(changes);
  const { FAKE_CLI_TRANSCRIPT: transcript, FAKE_CLI_TRANSCRIPT_FROM: from } = process.env;
  if (transcript && from) {
    mkdirSync(dirname(transcript), { recursive: true });
    copyFileSync(from, transcript);
  }
  const resultType = process.env.FAKE_CLI_RESULT_TYPE;
  const noResult = lines.filter((line) => (JSON.parse(line) as { type: string }).type !== resultType);
  const sent = {
    replay: lines,
    'no-result': noResult,
    garbage: [lines[0], 'not a JSON line', ...lines.slice(1)],
    hang: noResult,
    'hang-no-transcript': noResult,
    signal: noResult,
  }[mode];
  if (!sent) throw new Error(`the fake CLI has no mode ${mode}`);
  process.stdout.write(sent.map((line) => `${line}\n`).join(''), () => {
    if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
    else if (mode.startsWith('hang') && process.env.FAKE_CLI_SENT)
      writeFileSync(process.env.FAKE_CLI_SENT, String(process.pid));
  });
  if (mode.startsWith('hang')) setTimeout(() => {}, LIVES_MS);
  else if (mode !== 'signal') process.exitCode = exitCode;
}
