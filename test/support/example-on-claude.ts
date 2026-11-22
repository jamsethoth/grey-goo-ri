// The example's first-visit pass on the Claude Harness, over the recorded CLI (#486): the recordings
// scripts/record-claude.ts makes of that pass through gg, read raw from test/fixtures/claude/, and the example fixture
// run with its Agents on Claude, each launch replaying the next recording in the fake CLI and the example's test
// command run for real (Q2 A). It spawns, so only medium tests call it. It reads no Claude-private helper of
// lib/harnesses/claude.ts (planning Q12): the Harness is the one `shipped` builds, as gg run builds it.
import type { TestContext } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import type * as events from '../../lib/events.ts';
import type * as record from '../../lib/record.ts';
import * as exampleRun from './example-run.ts';
import type * as goldenRun from './golden-run.ts';

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

// The example fixture with its Agents on the Claude Harness (haiku, low effort, as recorded), built through
// `shipped.shipped` over a launch that starts the fake CLI, on the fake git and the real test command, run to its
// Terminal.
export async function runOverRecordings(t: TestContext): Promise<ExampleOnClaude> {
  // A stub until #486's Green: the example on the fake Harness and the stand-in suite, which no launch reaches.
  return { ...(await exampleRun.runExample(t)), calls: [] };
}
