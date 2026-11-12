import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as effectErrors from '../../lib/effect-errors.ts';
import * as effects from '../../lib/effects/index.ts';
import * as label from '../../lib/effects/label.ts';
import * as reset from '../../lib/effects/reset.ts';
import * as sideEffect from '../../lib/effects/side-effect.ts';
import * as record from '../../lib/record.ts';
import type * as visit from '../../lib/visit.ts';
import * as support from '../support/execution-context.ts';
import * as executionReads from '../support/execution-reads.ts';

// A reset's payload, which these cases only pass through.
const resetTo = (baseline: string): reset.Payload => ({ baseline, history: { kind: 'rescued', text: 'reset' } });

// The reset Effect with the perform a case gives: these cases are about the write-ahead steps, not the reset.
const performing = (perform: (payload: reset.Payload) => Promise<Record<string, string>>) => ({
  ...reset.effect,
  perform: async (_context: unknown, payload: reset.Payload) => perform(payload),
});

test('whileBusy marks the worktree busy while its function runs and idle after', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const during = await sideEffect.whileBusy(context, async () => ({ ...executionRecord.activity }));
  assert.deepEqual(during, { busy: true, generation: 1 });
  assert.deepEqual(executionRecord.activity, { busy: false, generation: 2 });
});

test('whileBusy marks the worktree idle after a failure, but leaves it busy after a crash', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  await assert.rejects(
    sideEffect.whileBusy(context, async () => {
      throw new Error('gh failed');
    }),
    /gh failed/,
  );
  assert.deepEqual(executionRecord.activity, { busy: false, generation: 2 });
  await assert.rejects(
    sideEffect.whileBusy(context, async () => {
      throw new effectErrors.CrashError('crash');
    }),
    effectErrors.CrashError,
  );
  assert.deepEqual(executionRecord.activity, { busy: true, generation: 3 });
});

test('a side effect is logged as intent, evidence and completion, and returns its evidence', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const evidence = await sideEffect.sideEffect(context, {
    actionMarker: 'gg:m',
    effect: performing(async () => ({ head: 'abc' })),
    payload: resetTo('abc'),
  });
  assert.deepEqual(evidence, { head: 'abc' });
  assert.deepEqual(executionReads.writeAheadSteps(executionRecord, 'gg:m'), ['intent', 'evidence', 'complete']);
});

test('a proven side effect is not made again: its saved evidence is returned and the Action completed', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  record.intent(executionRecord, 'gg:m', 'reset', resetTo('abc'));
  record.evidence(executionRecord, 'gg:m', { head: 'saved' });
  const evidence = await sideEffect.sideEffect(context, {
    actionMarker: 'gg:m',
    effect: performing(async () => assert.fail('a proven effect is made again')),
    payload: resetTo('abc'),
  });
  assert.deepEqual(evidence, { head: 'saved' });
  assert.deepEqual(executionReads.writeAheadSteps(executionRecord, 'gg:m'), ['intent', 'evidence', 'complete']);
});

test('a deferred side effect is left for saveResolution to complete', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  const perform = async () => ({ head: 'abc' });
  const evidence = await sideEffect.sideEffect(context, {
    actionMarker: 'gg:m',
    effect: performing(perform),
    payload: resetTo('abc'),
    deferred: true,
  });
  assert.deepEqual(evidence, { head: 'abc' });
  assert.deepEqual(executionReads.writeAheadSteps(executionRecord, 'gg:m'), ['intent', 'evidence']);
});

test('an open intent is redone with its intended payload, not the one given now', async (t) => {
  const { context, executionRecord } = await support.executionContext(t);
  record.intent(executionRecord, 'gg:m', 'reset', resetTo('intended'));
  const evidence = await sideEffect.sideEffect(context, {
    actionMarker: 'gg:m',
    effect: performing(async (payload) => ({ head: payload.baseline })),
    payload: resetTo('now'),
  });
  assert.deepEqual(evidence, { head: 'intended' });
  assert.equal(executionRecord.writeAheadLog.filter((entry) => entry.step === 'intent').length, 1);
});

test("saveResolution saves a Flow Action's settled resolution with its Action Event", async (t) => {
  const { context, executionRecord, emitted } = await support.executionContext(t);
  executionRecord.visitState = {
    recovery: 0,
    firstAttemptBaseline: null,
    call: null,
    response: null,
    runs: new Map(),
    checks: new Map(),
    checkFollows: false,
    settled: null,
    unconfirmedCleanup: null,
  };
  const resolution: visit.TableResolution = {
    outcome: 'ok',
    direction: 'advance',
    rule: { table: 'passed', row: 0 },
    row: null,
    check: null,
    retryAfterMs: null,
    retryKind: null,
    failureClass: null,
  };
  const actionIdentity = { ...support.PUSH_ACTION_IDENTITY, action: 'test' };
  const finished = await sideEffect.saveResolution(context, {
    actionIdentity,
    startedAt: 5,
    resolution,
    fields: { check: 'test' },
  });
  assert.equal(finished, resolution);
  assert.deepEqual(executionRecord.visitState.settled, { action: 'test', recovery: 0, resolution });
  assert.deepEqual(emitted, [
    {
      ...actionIdentity,
      startedAt: 5,
      outcome: 'ok',
      direction: 'advance',
      rule: { table: 'passed', row: 0 },
      signals: {},
      check: 'test',
    },
  ]);
  const saved = record.load(executionRecord.commonDir, 'ticket', support.TICKET);
  assert.deepEqual(saved?.visitState?.settled, { action: 'test', recovery: 0, resolution });
});

// eslint-disable-next-line @stylistic/max-len -- a case name stays whole, so grep finds it
test('saveResolution completes a marked Action with its evidence once, and returns a completed one unsaved', async (t) => {
  const { context, executionRecord, emitted } = await support.executionContext(t);
  record.intent(executionRecord, 'gg:m', 'push', { branch: 'ticket/8', sha: 'abc' });
  const resolution: visit.TableResolution = {
    outcome: 'ok',
    direction: 'retry',
    rule: { table: 'fixed', row: 'transient-retry' },
    row: null,
    check: null,
    retryAfterMs: null,
    retryKind: null,
    failureClass: null,
  };
  const actionIdentity = { ...support.PUSH_ACTION_IDENTITY, procedure: null };
  await sideEffect.saveResolution(context, {
    actionIdentity,
    startedAt: 5,
    resolution,
    actionMarker: 'gg:m',
    evidence: { remoteSha: 'abc' },
  });
  assert.deepEqual(executionReads.writeAheadSteps(executionRecord, 'gg:m'), ['intent', 'evidence', 'complete']);
  assert.equal(executionRecord.visitState, null, 'a Terminal Action or a retry settles nothing');
  assert.equal(
    await sideEffect.saveResolution(context, { actionIdentity, startedAt: 5, resolution, actionMarker: 'gg:m' }),
    resolution,
  );
  assert.equal(emitted.length, 1, 'a completed Action records no second Event');
});

test("a Flow Action's retry is not settled, so a resumed Visit runs the Action again", async (t) => {
  const { context, executionRecord, emitted } = await support.executionContext(t);
  executionRecord.visitState = {
    recovery: 0,
    firstAttemptBaseline: null,
    call: null,
    response: null,
    runs: new Map(),
    checks: new Map(),
    checkFollows: false,
    settled: null,
    unconfirmedCleanup: null,
  };
  const resolution: visit.TableResolution = {
    outcome: 'failed',
    direction: 'retry',
    rule: { table: 'fixed', row: 'transient-retry' },
    row: 'transient-retry',
    check: null,
    retryAfterMs: 60_000,
    retryKind: 'transient',
    failureClass: 'transient',
  };
  const actionIdentity = { ...support.PUSH_ACTION_IDENTITY, action: 'green' };
  await sideEffect.saveResolution(context, { actionIdentity, startedAt: 5, resolution });
  assert.equal(executionRecord.visitState.settled, null);
  assert.deepEqual(
    emitted.map((event) => [event.action, event.direction]),
    [['green', 'retry']],
    'its Action Event is still recorded',
  );
});

test('a completed side effect finishes as effect-completed', async (t) => {
  const { context, executionRecord, emitted } = await support.executionContext(t);
  record.intent(executionRecord, 'gg:m', 'push', { branch: 'ticket/8', sha: 'abc' });
  const actionIdentity = { ...support.PUSH_ACTION_IDENTITY, procedure: null };
  assert.deepEqual(await sideEffect.completeEffect(context, actionIdentity, 5, 'gg:m'), {
    outcome: 'ok',
    direction: 'advance',
    row: 'effect-completed',
    rule: { table: 'fixed', row: 'effect-completed' },
  });
  assert.deepEqual(executionReads.writeAheadSteps(executionRecord, 'gg:m'), ['intent', 'complete']);
  assert.deepEqual(
    emitted.map((event) => [event.action, event.outcome, event.rule]),
    [['push', 'ok', { table: 'fixed', row: 'effect-completed' }]],
  );
});

const EFFECT_NAMES = ['commit', 'push', 'comment', 'pr-upsert', 'pr-ready', 'label', 'rescue', 'reset'];

test('the lookup holds the eight Effects by the names their intents persist, and nothing else', () => {
  assert.deepEqual(
    effects.all().map((effect) => effect.name),
    EFFECT_NAMES,
  );
  for (const name of EFFECT_NAMES) assert.equal(effects.lookup(name)?.name, name);
  // A call is an agent Attempt's intent, not an Effect (ADR 0011); an unknown name is held (N3).
  for (const name of ['call', 'teleport', null]) {
    assert.equal(effects.lookup(name), undefined, String(name));
    assert.equal(effects.recognised(name), false, String(name));
  }
});

test('the remote Actions are the comment, PR upsert, push and PR ready', () => {
  assert.deepEqual(
    effects.all().map((effect) => [effect.name, effect.remote]),
    [
      ['commit', null],
      ['push', 'origin'],
      ['comment', 'GitHub'],
      ['pr-upsert', 'GitHub'],
      ['pr-ready', 'GitHub'],
      ['label', null],
      ['rescue', null],
      ['reset', null],
    ],
  );
});

test('an open intent is settled by its finder, as safe to repeat, or from the worktree; three prove one', () => {
  const settled = (effect: effects.Resumable) => {
    if (effect.find) return 'find';
    return effect.repeatable ? 'repeat' : 'worktree';
  };
  assert.deepEqual(
    effects.all().map((effect) => [effect.name, settled(effect), !!effect.proves]),
    [
      ['commit', 'find', true],
      ['push', 'find', false],
      ['comment', 'find', false],
      ['pr-upsert', 'find', false],
      ['pr-ready', 'repeat', false],
      ['label', 'find', false],
      ['rescue', 'find', true],
      ['reset', 'worktree', true],
    ],
  );
  assert.deepEqual(
    EFFECT_NAMES.filter((name) => effects.recognised(name)),
    EFFECT_NAMES.filter((name) => name !== 'reset'),
  );
});

const root = fileURLToPath(new URL('../..', import.meta.url));
const isEffect = (value: unknown): value is effects.Effect<never, never> =>
  !!value && typeof value === 'object' && 'name' in value && 'perform' in value;

// Every Effect value a module of lib/effects/ exports, label's two policies included.
async function exportedEffects(): Promise<[string, effects.Effect<never, never>][]> {
  const files = readdirSync(`${root}lib/effects`).filter((file) => !['index.ts', 'side-effect.ts'].includes(file));
  assert.ok(files.length >= 8, 'the Effect modules are read');
  const found: [string, effects.Effect<never, never>][] = [];
  for (const file of files) {
    const exported: Record<string, unknown> = await import(pathToFileURL(`${root}lib/effects/${file}`).href);
    for (const [name, value] of Object.entries(exported)) if (isEffect(value)) found.push([`${file} ${name}`, value]);
  }
  return [...found, ['label.ts keepOpen()', label.keepOpen(() => new Error('kept open'))]];
}

test('every Effect lib/effects/ exports is the one its persisted name looks up', async () => {
  const exported = await exportedEffects();
  assert.deepEqual([...new Set(exported.map(([, effect]) => effect.name))].sort(), [...EFFECT_NAMES].sort());
  for (const [where, effect] of exported) {
    const looked = effects.lookup(effect.name);
    assert.ok(looked, where);
    for (const part of ['remote', 'find', 'repeatable', 'proves'] as const)
      assert.equal(effect[part], looked[part], `${where}: ${part}`);
  }
});

const NAMES = EFFECT_NAMES.join('|');
// The ways a module matches an Effect by its name: a comparison with one, a list of three or more, the lists this
// ticket removed, or a comment posted by hand. The corrupt-row notice admission posts is no Action's, so not an Effect.
const SCATTERED: [RegExp, string][] = [
  [new RegExp(`\\beffect\\s*[!=]==?\\s*'(?:${NAMES})'`), 'compares an effect with a name'],
  [new RegExp(`'(?:${NAMES})'\\s*,\\s*'(?:${NAMES})'\\s*,\\s*'(?:${NAMES})'`), 'lists effect names'],
  [/\b(?:REMOTE_ACTIONS|FINDERS|REPLAYS)\b/, 'keeps a list of effect names'],
  [/\bgh\.comment\(/, 'posts a comment outside the comment Effect'],
];
const scattered = (path: string, text: string) =>
  SCATTERED.filter(([re, what]) => re.test(text) && !(what.startsWith('posts') && path === 'lib/admission.ts')).map(
    ([, what]) => `${path} ${what}`,
  );

test('no module outside lib/effects/ matches an Effect by its name or makes one by hand', () => {
  assert.deepEqual(scattered('lib/sample.ts', "if (entry.effect === 'commit') return;"), [
    'lib/sample.ts compares an effect with a name',
  ]);
  assert.deepEqual(scattered('lib/sample.ts', "const R = ['comment', 'pr-upsert', 'push'];"), [
    'lib/sample.ts lists effect names',
  ]);
  const modules = readdirSync(`${root}lib`, { recursive: true, encoding: 'utf8' })
    .map((file) => `lib/${file.split('\\').join('/')}`)
    .filter((path) => path.endsWith('.ts') && !path.startsWith('lib/effects/'));
  assert.ok(modules.includes('lib/reconcile.ts'), 'the lib modules are read');
  assert.deepEqual(
    modules.flatMap((path) => scattered(path, readFileSync(root + path, 'utf8'))),
    [],
  );
  for (const gone of ['lib/effects.ts', 'lib/effect-evidence.ts']) assert.equal(existsSync(root + gone), false, gone);
});
