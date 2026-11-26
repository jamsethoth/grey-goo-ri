// The example's first-visit pass recorded through gg (#486, Q1 A): the example fixture's Execution run by
// runExecution with its Agents on the Claude Harness `shipped` builds, on real git, the real test command and the fake
// gh, each call's launch passed to the real CLI and saved as it ends, with the files it changed in the worktree. For
// scripts/record-claude.ts alone, whose `example` name runs it; test/e2e/interpreter.claude.test.ts replays it.
import { test, type TestContext } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type * as exec from '../lib/exec.ts';
import * as shipped from '../lib/harnesses/shipped.ts';
import type * as runContext from '../lib/run-context.ts';
import * as exampleOnClaude from '../test/support/example-on-claude.ts';
import * as goldenRun from '../test/support/golden-run.ts';

export interface ExampleRecorder {
  cliVersion: string;
  launch: exec.Exec['launch'];
  save: (name: string, redact: (text: string) => string, lines: string[], meta: object) => void;
  redactorOf: (base: string) => (text: string) => string;
}

// Each file in a worktree by its path with forward slashes, git's own files left out.
function filesOf(worktree: string): Map<string, string> {
  const paths = (readdirSync(worktree, { recursive: true }) as string[]).filter(
    (path) => !/^(?:\.git|node_modules)(?:[\\/]|$)/.test(path) && statSync(join(worktree, path)).isFile(),
  );
  return new Map(
    paths.map((path) => [
      relative(worktree, join(worktree, path)).split(sep).join('/'),
      readFileSync(join(worktree, path), 'utf8'),
    ]),
  );
}

// What a call changed: each file it added or changed, with its content, and each it deleted, as null.
function changesOf(before: Map<string, string>, after: Map<string, string>): Record<string, string | null> {
  const changed = [...after].filter(([path, text]) => before.get(path) !== text);
  const deleted = [...before.keys()].filter((path) => !after.has(path)).map((path) => [path, null]);
  return Object.fromEntries([...changed, ...deleted]);
}

// The launch each Attempt makes, passed to `launch` and saved when it ends under the next name of
// exampleOnClaude.RECORDINGS, redacted against the fixture's directory.
function recordingLaunch(recorder: ExampleRecorder, where: { root: string }, made: string[]) {
  return async (options: exec.LaunchOptions) => {
    const before = filesOf(options.cwd ?? '.');
    const [lines, timesMs, started] = [[] as string[], [] as number[], Date.now()];
    const onLine = (line: string) => {
      lines.push(line);
      timesMs.push(Date.now() - started);
      options.onLine?.(line);
    };
    const ended = await recorder.launch({ ...options, onLine });
    const name = exampleOnClaude.RECORDINGS[made.length] ?? `example-extra-${made.length}`;
    const meta = {
      cliVersion: recorder.cliVersion,
      scenario: name,
      purpose: `call ${made.length + 1} of the example's first-visit pass, recorded through gg (#486)`,
      launchProfile: shipped.HARNESSES.claude.launchProfile,
      command: { executable: options.command, argv: options.args, env: options.env, stdin: options.input },
      exitCode: ended.code,
      signal: ended.signal,
      killed: ended.cancelled ? 'cancelled' : ended.timedOut,
      lineTimesMs: timesMs,
      stderr: ended.stderrTail,
      changes: changesOf(before, filesOf(options.cwd ?? '.')),
    };
    recorder.save(name, recorder.redactorOf(where.root), lines, meta);
    made.push(name);
    console.log(`${name}: exit ${ended.code}, ${lines.length} lines`);
    return ended;
  };
}

// The recordings make no doctor call, so no containment probe.
const noProbe = () => Promise.reject(new Error('the recorder runs no containment probe'));

async function recordIn(testContext: TestContext, recorder: ExampleRecorder) {
  const where = { root: '' };
  const made: string[] = [];
  const harness = shipped.shipped({ launch: recordingLaunch(recorder, where, made), childInJob: noProbe }).claude;
  const fixture = await exampleOnClaude.claudeFixture(testContext, harness as unknown as runContext.Harness, {
    git: 'real',
  });
  where.root = fixture.root;
  const ran = await goldenRun.ranToEnd(fixture);
  const ended = ran.executionRecord.terminalReason?.text ?? ran.executionRecord.state;
  console.log(`the example ended: ${ended}; ${made.length} calls recorded: ${made.join(', ')}`);
  if (ran.executionRecord.state !== 'ready-for-qa') console.log(JSON.stringify(ran.events.at(-1), null, 1));
  return made.length === exampleOnClaude.RECORDINGS.length && ran.executionRecord.state === 'ready-for-qa';
}

// Runs the pass once, under node:test for the test context the fixture cleans up with; whether it took the
// first-visit pass, one call each recording.
export async function recordExample(recorder: ExampleRecorder): Promise<boolean> {
  const passed = { first: false };
  await test("the example's first-visit pass on the real Claude CLI", async (testContext) => {
    passed.first = await recordIn(testContext, recorder);
  });
  return passed.first;
}
