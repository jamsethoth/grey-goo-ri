// The golden Execution whose red agent calls are interrupted: the Harness writes its files and gg dies before the
// call returns, as a killed gg process leaves it. `resumed` runs the next Execution on the record as saved.
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import * as interpreter from '../../lib/interpreter.ts';
import * as marker from '../../lib/marker.ts';
import * as rescue from '../../lib/rescue.ts';
import type * as commandCleanup from '../../lib/command-cleanup.ts';
import * as executionReads from './execution-reads.ts';
import type * as fakeHarness from './fake-harness.ts';
import * as golden from './golden.ts';
import * as keys from './keys.ts';

export const callOf = (attempt: number) => keys.responseKey('red', 1, 'red', attempt);

// What an interrupted Attempt leaves: a tracked change, an untracked file, an untracked test and an ignored Protected
// File, which only the rescue's own restore keeps.
export const LEFT: Record<string, string> = {
  'package.json': '{ "name": "changed by red" }\n',
  'notes.txt': 'what red tried\n',
  'test/add.test.mjs': "import { add } from '../lib/add.mjs';\n",
  '.claude/settings.local.json': '{ "left": true }\n',
};
const BASE_FILES = { '.gitignore': '.claude/settings.local.json\n' };

const uncontained: commandCleanup.CleanupReport = {
  confirmed: true,
  survivors: [],
  reason: null,
  containment: { kind: 'none' },
};

// How each interrupted call ends: `job` or `none`, reported before gg dies, or `unsaved`, gg dying before the Harness
// reports its containment.
export type Interruption = 'job' | 'none' | 'unsaved';

type Scripted = { files?: Record<string, string>; earlier?: fakeHarness.ScriptedResponses };

// red's responses: each interrupted Attempt writes `files`, and the one after the last completes. `earlier` scripts the
// Attempts before an interrupted one, by response key.
export function interruptedResponses(
  interrupted: Record<number, Interruption>,
  { files = LEFT, earlier = {} }: Scripted = {},
): fakeHarness.ScriptedResponses {
  const responses: fakeHarness.ScriptedResponses = { ...structuredClone(golden.firstVisitResponses), ...earlier };
  const completed = structuredClone(golden.firstVisitResponses)[callOf(1)]!;
  for (const [attempt, how] of Object.entries(interrupted))
    responses[callOf(Number(attempt))] = {
      ...completed,
      files: { ...completed.files, ...files },
      ...(how === 'none' && { cleanup: uncontained }),
    };
  const last = Math.max(...Object.keys(interrupted).map(Number));
  responses[callOf(last + 1)] = completed;
  return responses;
}

// gg dies during each interrupted red call, once the Harness has written its files.
export function interrupting(harness: fakeHarness.FakeHarness, interrupted: Record<number, Interruption>) {
  const run = harness.run;
  harness.run = (async (call: Record<string, unknown>, ...hooks: unknown[]) => {
    const how = call.vertex === 'red' ? interrupted[call.attempt as number] : undefined;
    if (!how) return (run as (...args: unknown[]) => Promise<unknown>)(call, ...hooks);
    await (run as (...args: unknown[]) => Promise<unknown>)(call, ...(how === 'unsaved' ? [] : hooks));
    throw new interpreter.CrashError(`gg was killed during ${call.marker as string}`);
  }) as typeof run;
}

export async function interruptedFixture(
  t: TestContext,
  interrupted: Record<number, Interruption>,
  scripted: Scripted = {},
) {
  const responses = interruptedResponses(interrupted, scripted);
  const fixture = await golden.fixture(t, { responses, integrity: 'real', git: 'real', baseFiles: BASE_FILES });
  interrupting(fixture.harness, interrupted);
  return fixture;
}

// One Execution that gg's death ends mid-call.
export async function crashed(fixture: golden.GoldenFixture, options: Partial<interpreter.ExecutionOptions> = {}) {
  await assert.rejects(
    interpreter.runExecution({ ...fixture.options, record: executionReads.loadTicket(fixture), ...options }),
    (err) => err instanceof interpreter.CrashError,
  );
}

export const resumed = (fixture: golden.GoldenFixture) =>
  interpreter.runExecution({ ...fixture.options, record: executionReads.loadTicket(fixture) });

// The Rescue Ref of red's interrupted Attempt `attempt`.
export const refOf = (fixture: golden.GoldenFixture, attempt: number) =>
  rescue.rescueRef(golden.markerOf(fixture.executionRecord, 'red', 1, 'interrupted-rescue', 0, attempt));

// The red Attempts the Harness was called for, with the Session each resumed.
export const redCalls = (fixture: golden.GoldenFixture) =>
  fixture.harness.calls.filter((call) => call.marker?.includes(':red:') ?? false);

// The crash budget spent on red's Action, as saved.
export const crashBudget = (fixture: golden.GoldenFixture): number | undefined =>
  executionReads.loadTicket(fixture).retries[
    marker.actionKeyOf({ vertex: 'red', visit: 1, action: 'red', recovery: 0 })
  ]?.crash;
