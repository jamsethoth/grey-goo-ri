import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as attempt from '../../lib/attempt.ts';
import * as effectErrors from '../../lib/effect-errors.ts';
import * as reset from '../../lib/effects/reset.ts';
import * as sideEffect from '../../lib/effects/side-effect.ts';
import * as record from '../../lib/record.ts';
import type * as visit from '../../lib/visit.ts';
import * as visitScope from '../../lib/visit-scope.ts';
import * as support from '../support/execution-context.ts';
import * as executionReads from '../support/execution-reads.ts';

const IDENTITY = support.PUSH_ACTION_IDENTITY;
const TERMINAL_IDENTITY = { ...IDENTITY, procedure: null };

// A reset's payload, which these cases only pass through.
const resetTo = (baseline: string): reset.Payload => ({ baseline, history: { kind: 'rescued', text: 'reset' } });

// The reset Effect with the perform a case gives: these cases are about the Attempt, not the reset.
const performing = (perform: (payload: reset.Payload) => Promise<Record<string, string>>) => ({
  ...reset.effect,
  perform: async (_context: unknown, payload: reset.Payload) => perform(payload),
});

const emptyVisitState = (): visit.VisitState => ({
  recovery: 0,
  firstAttemptBaseline: null,
  call: null,
  response: null,
  runs: new Map(),
  checks: new Map(),
  checkFollows: false,
  settled: null,
  unconfirmedCleanup: null,
});

const tableResolution = (direction: visit.Direction): visit.TableResolution => ({
  outcome: 'ok',
  direction,
  rule: { table: 'passed', row: 0 },
  row: null,
  check: null,
  retryAfterMs: null,
  retryKind: null,
  failureClass: null,
});

// An effect Attempt, write-ahead under its own marker, whose result carries a commit's outputs.
function effectAttempt(
  context: support.ExecutionContext,
  perform: (payload: reset.Payload) => Promise<Record<string, string>>,
  given: Partial<attempt.Attempting<undefined, unknown, visit.EffectResolution>> = {},
) {
  return attempt.run(context, {
    actionIdentity: IDENTITY,
    busy: true,
    work: (_prepared, actionMarker) =>
      sideEffect.sideEffect(context, {
        actionMarker,
        effect: performing(perform),
        payload: resetTo('abc'),
        deferred: true,
      }),
    outputs: () => ({ outputs: { files: ['lib/add.mjs'] } }),
    finish: () => ({ resolution: attempt.EFFECT_COMPLETED }),
    ...given,
  });
}

test('whileBusy marks the worktree busy while its function runs and idle after', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const during = await attempt.whileBusy(context, async () => ({ ...executionRecord.activity }));
  assert.deepEqual(during, { busy: true, generation: 1 });
  assert.deepEqual(executionRecord.activity, { busy: false, generation: 2 });
});

test('whileBusy marks the worktree idle after a failure, but leaves it busy after a crash', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  await assert.rejects(
    attempt.whileBusy(context, async () => {
      throw new Error('gh failed');
    }),
    /gh failed/,
  );
  assert.deepEqual(executionRecord.activity, { busy: false, generation: 2 });
  await assert.rejects(
    attempt.whileBusy(context, async () => {
      throw new effectErrors.CrashError('crash');
    }),
    effectErrors.CrashError,
  );
  assert.deepEqual(executionRecord.activity, { busy: true, generation: 3 });
});

test("a Flow Action's settled resolution is saved with its Action Event", async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  executionRecord.visitState = emptyVisitState();
  const resolution = tableResolution('advance');
  const actionIdentity = { ...IDENTITY, action: 'test' };
  const finished = await attempt.run(context, {
    actionIdentity,
    busy: false,
    work: async () => null,
    finish: () => ({ resolution, fields: { check: 'test' } }),
    settle: (settled) => {
      executionRecord.visitState!.settled = { action: 'test', recovery: 0, resolution: settled! };
    },
  });
  assert.equal(finished, resolution);
  assert.deepEqual(executionRecord.visitState.settled, { action: 'test', recovery: 0, resolution });
  assert.deepEqual(
    support.actionEvents(executionRecord).map(({ action, outcome, direction, rule, check, durationMs }) => ({
      action,
      outcome,
      direction,
      rule,
      check,
      durationMs,
    })),
    [
      {
        action: 'test',
        outcome: 'ok',
        direction: 'advance',
        rule: { table: 'passed', row: 0 },
        check: 'test',
        durationMs: 0,
      },
    ],
  );
  const saved = record.load(executionRecord.commonDir, 'ticket', support.TICKET);
  assert.deepEqual(saved?.visitState?.settled, { action: 'test', recovery: 0, resolution });
});

test('an Attempt completes its marker with its evidence once; a complete one returns its saved result', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const actionMarker = context.markerOf(TERMINAL_IDENTITY);
  record.intent(executionRecord, actionMarker, 'push', { branch: 'ticket/8', sha: 'abc' });
  const resolution: visit.TableResolution = {
    ...tableResolution('retry'),
    rule: { table: 'fixed', row: 'transient-retry' },
  };
  const attempting = {
    actionIdentity: TERMINAL_IDENTITY,
    busy: false,
    work: async () => null,
    finish: () => ({ resolution, evidence: { remoteSha: 'abc' } }),
    resumed: (evidence: unknown) => evidence as visit.TableResolution,
  };
  await attempt.run(context, attempting);
  assert.deepEqual(executionReads.writeAheadSteps(executionRecord, actionMarker), ['intent', 'evidence', 'complete']);
  assert.equal(executionRecord.visitState, null, 'a Terminal Action or a retry settles nothing');
  assert.deepEqual(await attempt.run(context, attempting), { remoteSha: 'abc' });
  assert.equal(support.actionEvents(executionRecord).length, 1, 'a completed Action records no second Event');
});

test('a completed side effect finishes as effect-completed', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const actionMarker = context.markerOf(TERMINAL_IDENTITY);
  record.intent(executionRecord, actionMarker, 'push', { branch: 'ticket/8', sha: 'abc' });
  record.evidence(executionRecord, actionMarker, { remoteSha: 'abc' });
  assert.deepEqual(
    await attempt.effectAction(context, {
      actionIdentity: TERMINAL_IDENTITY,
      made: async () => ({
        effect: performing(async () => assert.fail('a proven effect is made again')),
        payload: resetTo('abc'),
      }),
    }),
    {
      outcome: 'ok',
      direction: 'advance',
      row: 'effect-completed',
      rule: { table: 'fixed', row: 'effect-completed' },
    },
  );
  assert.deepEqual(executionReads.writeAheadSteps(executionRecord, actionMarker), ['intent', 'evidence', 'complete']);
  assert.deepEqual(
    support.actionEvents(executionRecord).map((event) => [event.action, event.outcome, event.rule]),
    [['push', 'ok', { table: 'fixed', row: 'effect-completed' }]],
  );
});

// The crash points an effect Attempt passes (effectErrors.CrashPointName): its Effect's own, and its completion's.
const EFFECT_CRASH_POINTS: effectErrors.CrashPointName[] = ['before-effect', 'after-effect', 'after-completion'];

test('a crash at each crash point leaves an Attempt that resumes to the same result', async (t) => {
  for (const point of EFFECT_CRASH_POINTS) {
    await t.test(point, async (t) => {
      const { context, executionRecord } = await support.executionContext(t);
      const actionMarker = context.markerOf(IDENTITY);
      context.crashAt = { marker: actionMarker, point };
      await assert.rejects(
        effectAttempt(context, async () => ({ head: 'abc' })),
        effectErrors.CrashError,
      );
      delete context.crashAt;
      context.record = record.load(executionRecord.commonDir, 'ticket', support.TICKET)!;
      assert.deepEqual(await effectAttempt(context, async () => ({ head: 'abc' })), attempt.EFFECT_COMPLETED);
      const saved = record.load(executionRecord.commonDir, 'ticket', support.TICKET)!;
      assert.deepEqual(executionReads.writeAheadSteps(saved, actionMarker).at(-1), 'complete');
      assert.deepEqual(visitScope.outputOf(saved, IDENTITY)?.value, { files: ['lib/add.mjs'] });
      assert.equal(support.actionEvents(saved).length, 1, 'one Action Event across the crash');
    });
  }
});

test('a complete marker returns its saved result without running the work', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const actionMarker = context.markerOf(IDENTITY);
  record.intent(executionRecord, actionMarker, 'call', resetTo('abc'));
  record.complete(executionRecord, actionMarker, { evidence: { ...tableResolution('advance'), sessionId: 's1' } });
  const result = await attempt.run(context, {
    actionIdentity: IDENTITY,
    busy: true,
    prepare: async () => assert.fail('a complete Attempt prepares nothing'),
    work: async () => assert.fail('a complete Attempt runs no work'),
    finish: () => assert.fail('a complete Attempt saves nothing'),
    resumed: (evidence) => evidence as unknown as visit.TableResolution,
  });
  assert.deepEqual(result, { ...tableResolution('advance'), sessionId: 's1' });
  assert.equal(attempt.complete(context, IDENTITY), true);
  assert.deepEqual(executionRecord.activity, { busy: false, generation: 0 }, 'no busy bracket');
  assert.equal(support.actionEvents(executionRecord).length, 0);
});

test("outputs land in the completion's save and in no save before it", async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const outputsAtSave: unknown[] = [];
  context.database = record.createStateDatabase({
    beforeSave: (saved) => {
      outputsAtSave.push('outputs' in saved ? structuredClone(saved.outputs) : null);
    },
  });
  await effectAttempt(context, async () => ({ head: 'abc' }));
  const last = outputsAtSave.pop();
  assert.deepEqual(
    outputsAtSave.filter((outputs) => (outputs as unknown[]).length),
    [],
    'no earlier save has them',
  );
  assert.deepEqual(last, [{ vertex: 'green', visit: 1, action: 'push', value: { files: ['lib/add.mjs'] } }]);
  assert.deepEqual(executionReads.writeAheadSteps(executionRecord, context.markerOf(IDENTITY)), [
    'intent',
    'evidence',
    'complete',
  ]);

  // The save that carries them carries the Event: one that fails records neither.
  const failing = await support.executionContext(t);
  failing.context.database = record.createStateDatabase({
    beforeSave: (saved) => {
      if ('outputs' in saved && saved.outputs.length) throw new Error('disk full');
    },
  });
  await assert.rejects(
    effectAttempt(failing.context, async () => ({ head: 'abc' })),
    record.RecordSaveError,
  );
  assert.equal(support.actionEvents(failing.executionRecord).length, 0);
  const saved = record.load(failing.executionRecord.commonDir, 'ticket', support.TICKET)!;
  assert.deepEqual(saved.outputs, []);
});

test('a finish that throws takes its outputs back, so no later save publishes them without their result', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const failing = (outputs: visit.ActionOutputValue) =>
    attempt.run(context, {
      actionIdentity: IDENTITY,
      busy: false,
      work: async () => null,
      outputs: () => ({ outputs, dropped: ['files'] }),
      finish: () => {
        throw new Error('the Check result could not be saved');
      },
    });
  await assert.rejects(failing({ findingsHash: 'h1' }), /could not be saved/);
  assert.equal(executionRecord.outputs.length, 0, 'a new entry is removed');
  executionRecord.outputs.push({ vertex: 'green', visit: 1, action: 'push', value: { files: ['lib/add.mjs'] } });
  await assert.rejects(failing({ findingsHash: 'h2' }), /could not be saved/);
  assert.deepEqual(
    executionRecord.outputs,
    [{ vertex: 'green', visit: 1, action: 'push', value: { files: ['lib/add.mjs'] } }],
    'an earlier entry is as it was',
  );
  // A later save, as a fault's report makes, carries none of them.
  record.save(executionRecord);
  assert.deepEqual(record.load(executionRecord.commonDir, 'ticket', support.TICKET)?.outputs, executionRecord.outputs);
  assert.equal(support.actionEvents(executionRecord).length, 0);
});

test('the work runs inside the busy bracket only when the kind declares it', async (t) => {
  for (const busy of [true, false]) {
    await t.test(`busy: ${busy}`, async (t) => {
      const { context, executionRecord } = await support.executionContext(t);
      let during: boolean | null = null;
      await attempt.run(context, {
        actionIdentity: IDENTITY,
        busy,
        prepare: async () => assert.equal(executionRecord.activity.busy, false, 'preparation is not bracketed'),
        work: async () => {
          during = executionRecord.activity.busy;
        },
        finish: () => {
          assert.equal(executionRecord.activity.busy, false, 'the result is made after the bracket');
          return { resolution: tableResolution('advance') };
        },
      });
      assert.equal(during, busy);
      assert.equal(executionRecord.activity.generation, busy ? 2 : 0);
    });
  }
});

test('exactly one Action Event per Attempt', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  // A Check's Attempt has no write-ahead intent, so its save completes nothing.
  await attempt.run(context, {
    actionIdentity: { ...IDENTITY, action: 'check' },
    busy: false,
    work: async () => null,
    finish: () => ({ resolution: tableResolution('advance') }),
  });
  await effectAttempt(context, async () => ({ head: 'abc' }));
  await effectAttempt(context, async () => assert.fail('a complete Attempt runs again'));
  assert.deepEqual(
    support.actionEvents(executionRecord).map((event) => event.action),
    ['check', 'push'],
  );
  assert.deepEqual(
    executionReads.writeAheadSteps(executionRecord, context.markerOf({ ...IDENTITY, action: 'check' })),
    [],
  );
});

test('a held completion replaces the saved result with its Event, or leaves none for the Visit to route', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const actionMarker = context.markerOf(IDENTITY);
  record.intent(executionRecord, actionMarker, 'call', resetTo('abc'));
  record.complete(executionRecord, actionMarker, {
    evidence: { ...tableResolution('stop'), row: 'cleanup-unconfirmed' },
  });
  const settled: (visit.Resolution | null)[] = [];
  const replaced = await attempt.runHeld(context, {
    actionIdentity: IDENTITY,
    actionMarker,
    work: async () => null,
    outputs: () => ({
      outputs: { cleanup: { confirmed: true, survivors: [], reason: null, containment: { kind: 'none' } } },
    }),
    finish: () => ({ resolution: tableResolution('advance') }),
    settle: (resolution) => settled.push(resolution),
  });
  assert.deepEqual(replaced, tableResolution('advance'));
  assert.equal(
    executionRecord.writeAheadLog.find((entry) => entry.step === 'evidence')?.evidence?.direction,
    'advance',
  );
  assert.equal(
    await attempt.runHeld(context, {
      actionIdentity: IDENTITY,
      work: async () => null,
      finish: () => ({ resolution: null }),
      settle: (resolution) => settled.push(resolution),
    }),
    null,
  );
  assert.deepEqual(settled, [tableResolution('advance'), null]);
  assert.equal(support.actionEvents(executionRecord).length, 1, 'only a held completion with a result records one');
  const saved = record.load(executionRecord.commonDir, 'ticket', support.TICKET)!;
  assert.equal(visitScope.outputOf(saved, IDENTITY)?.value.cleanup?.confirmed, true);
});

test('a crash after a held completion leaves its replaced result saved, with its one Event', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const actionMarker = context.markerOf(IDENTITY);
  record.intent(executionRecord, actionMarker, 'call', resetTo('abc'));
  record.complete(executionRecord, actionMarker, {
    evidence: { ...tableResolution('stop'), row: 'cleanup-unconfirmed' },
  });
  context.crashAt = { marker: actionMarker, point: 'after-completion' };
  await assert.rejects(
    attempt.runHeld(context, {
      actionIdentity: IDENTITY,
      actionMarker,
      work: async () => null,
      finish: () => ({ resolution: tableResolution('advance') }),
    }),
    effectErrors.CrashError,
  );
  const saved = record.load(executionRecord.commonDir, 'ticket', support.TICKET)!;
  assert.equal(saved.writeAheadLog.find((entry) => entry.step === 'evidence')?.evidence?.direction, 'advance');
  assert.equal(support.actionEvents(saved).length, 1);
});

const root = fileURLToPath(new URL('../../', import.meta.url));
// What only lib/attempt.ts does for an Attempt, and what the other modules a rule names may do for what is no Attempt:
// the reset's own completion (lib/effects/side-effect.ts), Reconciliation's finish of a reset, the rescue output the
// next Vertex's entry saves (lib/visit-runner.ts), and the start of a remote launch or lookup (lib/remote-effects.ts),
// which a final failure's Event, recorded by lib/attempt.ts, measures from.
const ATTEMPT_RULES: { what: string; re: RegExp; allowed: string[] }[] = [
  {
    what: "reads whether an Attempt's marker is complete",
    re: /findEntry\([^;]*?'complete'\s*\)/,
    allowed: ['lib/attempt.ts', 'lib/effects/side-effect.ts'],
  },
  { what: 'writes visitState.settled', re: /\.settled\s*=(?!=)/, allowed: ['lib/visit-runner.ts'] },
  {
    what: 'records an output outside the save',
    re: /\brecordOutput\(/,
    allowed: ['lib/attempt.ts', 'lib/visit-scope.ts', 'lib/visit-runner.ts'],
  },
  {
    what: 'completes a marker',
    re: /\.complete\(\s*(?:executionRecord|record|context\.record|runContext\.record)\b/,
    allowed: ['lib/attempt.ts', 'lib/effects/side-effect.ts', 'lib/reconcile.ts'],
  },
  {
    what: 'takes an Attempt start time',
    re: /startedAt\s*=\s*\w+(?:\.\w+)*\.now\(\)/,
    allowed: ['lib/attempt.ts', 'lib/remote-effects.ts'],
  },
  { what: 'records an Action Event', re: /\.emit\(/, allowed: ['lib/attempt.ts'] },
];
const broken = (path: string, text: string) =>
  ATTEMPT_RULES.filter(({ re, allowed }) => !allowed.includes(path) && re.test(text)).map(
    ({ what }) => `${path} ${what}`,
  );

test('no module but lib/attempt.ts starts, completes or saves an Attempt, and only the Visit loop settles it', () => {
  assert.deepEqual(
    broken(
      'lib/sample.ts',
      [
        "if (writeAhead.findEntry(executionRecord, actionMarker, 'complete')) return;",
        'state.settled = null;',
        'visitScope.recordOutput(executionRecord, actionIdentity, { files });',
        'runContext.database.complete(executionRecord, actionMarker);',
        'const startedAt = runContext.clock.now();',
        'runContext.emit(actionIdentity, startedAt, {});',
      ].join('\n'),
    ),
    ATTEMPT_RULES.map(({ what }) => `lib/sample.ts ${what}`),
    'each rule finds its sample',
  );
  const modules = readdirSync(`${root}lib`, { recursive: true, encoding: 'utf8' })
    .map((file) => `lib/${file.split('\\').join('/')}`)
    .filter((path) => path.endsWith('.ts'));
  assert.ok(modules.includes('lib/agent-action.ts'), 'the lib modules are read');
  assert.deepEqual(
    modules.flatMap((path) => broken(path, readFileSync(root + path, 'utf8'))),
    [],
  );
  // The test support enters, marks and records each Action with runExecution's own methods (lib/run-context.ts).
  assert.doesNotMatch(
    readFileSync(`${root}test/support/execution-context.ts`, 'utf8'),
    /^\s*(?:enter|markerOf|emit)\s*:/m,
  );
});
