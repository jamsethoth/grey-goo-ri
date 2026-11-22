// The example's first-visit pass on the Claude Harness, over the recorded CLI (#486): the recordings
// scripts/record-claude.ts makes of that pass through gg, read raw from test/fixtures/claude/, and the example fixture
// run with its Agents on Claude, each launch replaying the next recording in the fake CLI and the example's test
// command run for real (Q2 A). It spawns, so only medium tests call it. It calls no Claude-private helper of
// lib/harnesses/claude.ts (planning Q12): the replay's Harness is the fake CLI's (claude-over-fake-cli.ts), built as
// `shipped` builds it but over a Claude configuration directory of the case's own, and the recorder's is the one
// `shipped` builds, as gg run builds it.
import type { TestContext } from 'node:test';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as exec from '../../lib/exec.ts';
import * as paths from '../../lib/paths.ts';
import type * as events from '../../lib/events.ts';
import type * as record from '../../lib/record.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as claudeOverFakeCli from './claude-over-fake-cli.ts';
import * as exampleRun from './example-run.ts';
import * as golden from './golden.ts';
import * as goldenRun from './golden-run.ts';

// The recordings of the example's first-visit pass, one per agent Action in call order: red's, green's and review's.
export const RECORDINGS = ['example-red', 'example-green', 'example-review'];

const recordingFile = (name: string, extension: string) =>
  new URL(`../fixtures/claude/${name}${extension}`, import.meta.url);

// What a recording's .json says it was recorded as and under: its scenario's name and the launch profile; null when
// the recording is missing.
export function recordedUnder(name: string): { scenario: unknown; launchProfile: unknown } | null {
  if (!existsSync(recordingFile(name, '.json'))) return null;
  const { scenario, launchProfile } = JSON.parse(readFileSync(recordingFile(name, '.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  return { scenario, launchProfile };
}

// The Usage counts a golden case checks on an agent Action Event.
export interface RecordedUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// The schema on a Claude call's argv, the value after --json-schema.
export const schemaOf = (argv: readonly string[]) => argv[argv.indexOf('--json-schema') + 1];

// What the recorded call sent and Claude answered, read raw from the recording: the schema on its argv, its stream's
// lines, its Session, its structured output, and the Usage its result line reports, summed over its models.
export function recordedCall(name: string) {
  const meta = JSON.parse(readFileSync(recordingFile(name, '.json'), 'utf8')) as { command: { argv: string[] } };
  const lines = readFileSync(recordingFile(name, '.jsonl'), 'utf8').split('\n').filter(Boolean);
  const result = JSON.parse(lines.at(-1)!) as {
    session_id: string;
    structured_output: unknown;
    total_cost_usd: number;
    modelUsage: Record<string, { inputTokens: number; outputTokens: number }>;
  };
  const models = Object.values(result.modelUsage);
  const usage: RecordedUsage = {
    inputTokens: models.reduce((total, model) => total + model.inputTokens, 0),
    outputTokens: models.reduce((total, model) => total + model.outputTokens, 0),
    costUsd: result.total_cost_usd,
  };
  return {
    schema: schemaOf(meta.command.argv),
    lines,
    sessionId: result.session_id,
    response: result.structured_output,
    usage,
  };
}

// The agent Action Events of a Run, in the order appended.
export const agentEvents = (appended: events.ReadEvent[]) =>
  appended.filter((event): event is events.AgentActionEvent => event.type === 'action' && event.agent);

// A Usage's counts a golden case checks.
export const countsOf = ({ inputTokens, outputTokens, costUsd }: events.Usage) => ({
  inputTokens,
  outputTokens,
  costUsd,
});

// The transcript a saved Session names, line by line; none when it names none or the file is gone.
const transcriptLines = (path: string | null) =>
  path !== null && existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : [];

// Each Session an Execution Record saved, by its key: its Harness, its id and its transcript's lines.
export const savedSessions = (executionRecord: record.ExecutionRecord) =>
  Object.entries(executionRecord.sessions).map(([key, { harness, sessionId, transcriptPath }]) => ({
    key,
    harness,
    sessionId,
    transcript: transcriptLines(transcriptPath),
  }));

// The example run over the recordings: how it ended and what it left, and each launch as the fake CLI received it
// with the recording it replayed.
export type ExampleOnClaude = goldenRun.GoldenRun & {
  calls: { recording: string; argv: string[]; stdin: string }[];
};

// The example's Agents on Claude, as recorded: its cheapest model at low effort (planning Q17).
const ON_CLAUDE = { harness: 'claude', model: 'haiku', effort: 'low' };

// The example fixture with its Agents on the Claude Harness `harness` and the example's test command run for real
// (Q2 A), with the Run directory gg run makes, where the Harness writes the files its launch names. It runs nothing;
// scripts/record-claude.ts builds it over the real CLI.
export async function claudeFixture(
  t: TestContext,
  harness: runContext.Harness,
  options?: exampleRun.ExampleOptions,
): Promise<golden.GoldenFixture> {
  const fixture = await exampleRun.exampleFixture(t, options);
  golden.configure(fixture, (configured) => {
    for (const agent of Object.values(configured.agents)) Object.assign(agent, ON_CLAUDE);
  });
  fixture.options.harness = harness;
  fixture.options.deps.exec = exec.createExec();
  mkdirSync(paths.runDirectory(fixture.commonDir, fixture.executionRecord.run), { recursive: true });
  // A test runner running the case sets NODE_TEST_CONTEXT, which the example's own node --test would inherit and so
  // report to it, printing no test names; the variable is back once the case ends.
  const runnerContext = process.env.NODE_TEST_CONTEXT;
  Reflect.deleteProperty(process.env, 'NODE_TEST_CONTEXT');
  t.after(() => {
    if (runnerContext !== undefined) process.env.NODE_TEST_CONTEXT = runnerContext;
  });
  return fixture;
}

// The example fixture on the Claude Harness over the fake CLI, which replays the recordings in turn, on the fake git
// and the real test command, run to its Terminal.
export async function runOverRecordings(t: TestContext): Promise<ExampleOnClaude> {
  const fake = claudeOverFakeCli.claudeOverFakeCli(t, { scenario: RECORDINGS, spaced: false });
  const ran = await goldenRun.ranToEnd(await claudeFixture(t, fake.harness));
  return { ...ran, calls: fake.calls() };
}
