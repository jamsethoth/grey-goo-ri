// The example's first-visit pass recorded through gg on Codex (#482 Q1 A), as scripts/record-claude-example.ts records
// it on Claude (#486): the example fixture's Execution run by runExecution with every Agent on the Codex Harness
// `shipped` builds (example-on-codex.ts gives the model and effort), on real git, the real test command and the fake
// gh, each launch inside a Windows job as gg runs it. Each `codex exec` call is saved as it ends, with the schema gg
// sent it, its thread, its final message (-o), its rollout and the files it changed; the listings pass through
// unrecorded. For scripts/record-codex.ts alone, whose `example` name runs it; test/e2e/interpreter.codex.test.ts
// replays it.
import { test, type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as commandShim from '../lib/command-shim.ts';
import * as containment from '../lib/containment.ts';
import * as exec from '../lib/exec.ts';
import * as codex from '../lib/harnesses/codex.ts';
import * as codexStream from '../lib/harnesses/codex-stream.ts';
import * as shipped from '../lib/harnesses/shipped.ts';
import type * as runContext from '../lib/run-context.ts';
import * as exampleOnCodex from '../test/support/example-on-codex.ts';
import * as goldenRun from '../test/support/golden-run.ts';
import * as cliRecording from './cli-recording.ts';
import * as homeGuard from './record-codex-home.ts';
import * as redaction from './record-codex-redaction.ts';

type Redact = (text: string) => string;

// What scripts/record-codex.ts gives the example: its usage, the session's variables a nested CLI must not inherit,
// and its saves into test/fixtures/codex/.
export interface ExampleRecorder {
  usage: string;
  inherited: RegExp;
  output: string;
  save: (name: string, redact: Redact, lines: string[], meta: object) => void;
  writeLines: (file: string, redact: Redact, lines: string[]) => void;
}

interface Recording {
  recorder: ExampleRecorder;
  cliVersion: string;
  launch: exec.Exec['launch'];
  codexHome: string;
}

// The value after `flag` on an argv, or undefined.
const valueAfter = (argv: readonly string[], flag: string) =>
  argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined;
const textOf = (path: string | undefined) =>
  path !== undefined && existsSync(path) ? readFileSync(path, 'utf8') : null;

// The owner allowed one real call each recording (Q1 A): a call past them, a recovery pass say, starts nothing.
export function nameOf(made: number): string {
  const name = exampleOnCodex.RECORDINGS[made];
  if (name === undefined)
    throw new Error(
      `the example asked for call ${made + 1}; the recorder makes ${exampleOnCodex.RECORDINGS.length} (#482 Q1 A)`,
    );
  return name;
}

// One `codex exec` launch, passed to the real CLI and saved when it ends under `name`, redacted against `root`.
async function recordCall(recording: Recording, options: exec.LaunchOptions, name: string, root: string) {
  const { recorder, codexHome } = recording;
  const cwd = options.cwd ?? '.';
  const before = cliRecording.filesOf(cwd);
  const schemaPath = valueAfter(options.args, '--output-schema');
  const schema: unknown = schemaPath === undefined ? null : JSON.parse(readFileSync(schemaPath, 'utf8'));
  const [lines, timesMs, started] = [[] as string[], [] as number[], Date.now()];
  const onLine = (line: string) => {
    lines.push(line);
    timesMs.push(Date.now() - started);
    options.onLine?.(line);
  };
  const guard = homeGuard.guard(codexHome, null);
  const ended = await recording.launch({ ...options, onLine });
  const homeChanges = guard.restore();
  const { threadId } = codexStream.read(lines);
  const rollout = threadId === null ? null : codexStream.rollout(codexHome, threadId);
  const meta = {
    cliVersion: recording.cliVersion,
    scenario: name,
    purpose: `call ${exampleOnCodex.RECORDINGS.indexOf(name) + 1} of the example's first-visit pass, through gg (#482)`,
    launchProfile: shipped.HARNESSES.codex.launchProfile,
    command: { executable: options.command, argv: options.args, env: options.env, stdin: options.input, schema },
    threadId,
    exitCode: ended.code,
    signal: ended.signal,
    killed: ended.cancelled ? 'cancelled' : ended.timedOut,
    lineTimesMs: timesMs,
    stderr: ended.stderrTail,
    lastMessage: textOf(valueAfter(options.args, '-o')),
    rolloutPath: rollout?.path ?? null,
    homeChanges,
    changes: cliRecording.changesOf(before, cliRecording.filesOf(cwd)),
  };
  const redact = redaction.redactorOf(root);
  recorder.save(name, redact, lines, meta);
  if (rollout !== null)
    recorder.writeLines(
      `${name}.rollout.jsonl`,
      redact,
      readFileSync(rollout.path, 'utf8').split('\n').filter(Boolean),
    );
  console.log(`${name}: exit ${ended.code}, ${lines.length} lines, thread ${threadId}`);
  return ended;
}

// The launch the Harness makes: its listings passed through, each model call recorded under the next name.
const recordingLaunch =
  (recording: Recording, where: { root: string }, made: string[]): exec.Exec['launch'] =>
  async (options) => {
    if (options.args[0] !== 'exec') return recording.launch(options);
    const name = nameOf(made.length);
    made.push(name);
    return recordCall(recording, options, name, where.root);
  };

async function recordIn(testContext: TestContext, recording: Recording) {
  const where = { root: '' };
  const made: string[] = [];
  const harness = shipped.shipped({ launch: recordingLaunch(recording, where, made) }).codex;
  const fixture = await exampleOnCodex.codexFixture(testContext, harness as unknown as runContext.Harness, {
    git: 'real',
  });
  where.root = fixture.root;
  const ran = await goldenRun.ranToEnd(fixture);
  const ended = ran.executionRecord.terminalReason?.text ?? ran.executionRecord.state;
  console.log(`the example ended: ${ended}; ${made.length} calls recorded: ${made.join(', ')}`);
  if (ran.executionRecord.state !== 'ready-for-qa') console.log(JSON.stringify(ran.events.at(-1), null, 1));
  return made.length === exampleOnCodex.RECORDINGS.length && ran.executionRecord.state === 'ready-for-qa';
}

// `example`, alone: the pass run once, under node:test for the test context the fixture cleans up with, in gg's Codex
// home; 0 when it took the first-visit pass, one call each recording.
export async function recordExample(names: string[], recorder: ExampleRecorder): Promise<number> {
  if (names.length > 1) {
    console.error(`example records alone\n${recorder.usage}`);
    return 2;
  }
  // gg's launch passes on the environment, so the session's own variables go first.
  for (const key of Object.keys(process.env))
    if (recorder.inherited.test(key)) Reflect.deleteProperty(process.env, key);
  const { command, args } = commandShim.argvOf('codex', ['--version']);
  const cliVersion = execFileSync(command, args, { encoding: 'utf8' }).trim();
  if (containment.openKernel32() === null) console.error('node:ffi is unavailable: calls run with no job');
  const { launch } = exec.createExec({ kernel32: containment.openKernel32() });
  mkdirSync(recorder.output, { recursive: true });
  const recording = { recorder, cliVersion, launch, codexHome: codex.codexHome() };
  const passed = { first: false };
  await test("the example's first-visit pass on the real Codex CLI", async (testContext) => {
    passed.first = await recordIn(testContext, recording);
  });
  console.log(
    passed.first ? `recorded the example's first-visit pass into ${recorder.output}` : 'the example left its pass',
  );
  return passed.first ? 0 : 1;
}
