// The example's first-visit pass on the Codex Harness, over the recorded CLI (#482 Q1 A), as example-on-claude.ts is
// for Claude (#486): the recordings scripts/record-codex.ts makes of that pass through gg, read raw from
// test/fixtures/codex/, and the example fixture run with every Agent on Codex, each launch replaying the next recording
// in the fake CLI (codex-over-fake-cli.ts), which writes each call's rollout and -o message as Codex does, and the
// example's test command run for real. It spawns, so only medium tests call it.
import type { TestContext } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import type * as runContext from '../../lib/run-context.ts';
import * as codexOverFakeCli from './codex-over-fake-cli.ts';
import * as exampleOnClaude from './example-on-claude.ts';
import type * as exampleRun from './example-run.ts';
import * as golden from './golden.ts';
import * as goldenRun from './golden-run.ts';

// The recordings of the example's first-visit pass, one per agent Action in call order: red's, green's and review's.
export const RECORDINGS = ['example-red', 'example-green', 'example-review'];

const recordingFile = (name: string, extension: string) =>
  new URL(`../fixtures/codex/${name}${extension}`, import.meta.url);

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

// The schema a Codex call was sent: the file its argv names after --output-schema, parsed; null when it is gone.
export function schemaOf(argv: readonly string[]): unknown {
  const path = argv[argv.indexOf('--output-schema') + 1];
  return path !== undefined && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens: number;
}

// What the recorded call sent and Codex answered, read raw from the recording: the schema gg wrote for it
// (`command.schema`), its thread, its final message from -o, its rollout's lines, and the Usage its last
// turn.completed reports by the token rules (request 3.7: Codex's input_tokens holds its cached and cache-write
// tokens; Codex reports no cost).
export function recordedCall(name: string) {
  const meta = JSON.parse(readFileSync(recordingFile(name, '.json'), 'utf8')) as {
    threadId: string;
    lastMessage: string;
    command: { schema: unknown };
  };
  const lines = readFileSync(recordingFile(name, '.jsonl'), 'utf8').split('\n').filter(Boolean);
  const completed = lines
    .map((line) => JSON.parse(line) as { type: string; usage?: CodexUsage })
    .findLast((event) => event.type === 'turn.completed');
  const usage = completed?.usage;
  return {
    schema: meta.command.schema,
    sessionId: meta.threadId,
    response: JSON.parse(meta.lastMessage) as unknown,
    rollout: readFileSync(recordingFile(name, '.rollout.jsonl'), 'utf8').split('\n').filter(Boolean),
    usage: usage && {
      inputTokens: usage.input_tokens - (usage.cached_input_tokens ?? 0) - (usage.cache_write_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
      costUsd: null,
    },
  };
}

// The example run over the recordings: how it ended and what it left, and each launch as the fake CLI received it
// with the recording it replayed.
export type ExampleOnCodex = goldenRun.GoldenRun & {
  calls: { recording: string; argv: string[]; stdin: string }[];
};

// The example's Agents on Codex, as recorded: the model and effort #479 recorded every call on.
const ON_CODEX = { harness: 'codex', model: 'gpt-6-luna', effort: 'low' };

// The example fixture with every Agent on the Codex Harness `harness`: the Claude fixture's real exec, Run directory
// and real test command, with its Agents moved onto Codex. It runs nothing; scripts/record-codex.ts builds it over the
// real CLI.
export async function codexFixture(
  t: TestContext,
  harness: runContext.Harness,
  options?: exampleRun.ExampleOptions,
): Promise<golden.GoldenFixture> {
  const fixture = await exampleOnClaude.claudeFixture(t, harness, options);
  golden.configure(fixture, (configured) => {
    for (const agent of Object.values(configured.agents)) Object.assign(agent, ON_CODEX);
    // Codex declares network unsupported, so an Agent on it sets none, as the example's own gg.json sets none.
    for (const agent of Object.values(configured.agents)) Reflect.deleteProperty(agent, 'network');
  });
  return fixture;
}

// The example fixture on the Codex Harness over the fake CLI, which replays the recordings in turn, on the fake git
// and the real test command, run to its Terminal.
export async function runOverRecordings(t: TestContext): Promise<ExampleOnCodex> {
  const fake = codexOverFakeCli.codexOverFakeCli(t, { scenario: RECORDINGS, spaced: false });
  const ran = await goldenRun.ranToEnd(await codexFixture(t, fake.harness as unknown as runContext.Harness));
  return { ...ran, calls: fake.calls() };
}
