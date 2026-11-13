// The readers of what an Execution Record's row nests for its Visits (lib/visit.ts): the Configuration Snapshot, the
// Visit's progress with its call, Checks and Resolution, each Action's outputs, and the worktree snapshots and cleanup
// reports those hold. Only lib/record-read.ts imports it.
import type * as commandCleanup from './command-cleanup.ts';
import type * as integrity from './integrity.ts';
import type * as recordJson from './record-json.ts';
import type * as runContext from './run-context.ts';
import type * as visit from './visit.ts';
import * as recordReadNode from './record-read-node.ts';

const { text, count, flag, json, nullable, list, keyed, oneOf, object, variant, tagged } = recordReadNode;
const nullableText = nullable(text);
const nullableCount = nullable(count);

export const ruleIdentity = object<visit.RuleIdentity>((field) => ({
  table: oneOf<visit.RuleIdentity['table']>({ fixed: true, stopped: true, passed: true, failed: true })(field('table')),
  row: nullable((node) => (typeof node.value === 'number' ? count(node) : text(node)))(field('row')),
}));

export const historyItem = object<visit.HistoryItem>((field) => ({
  kind: text(field('kind')),
  text: text(field('text')),
}));

export const worktreeSnapshot = object<integrity.WorktreeSnapshot>((field) => ({
  head: text(field('head')),
  index: text(field('index')),
  tree: text(field('tree')),
}));

// Each a link's target or the bytes in base64, told apart by its key.
export const untrackedFiles = keyed(
  variant<integrity.UntrackedFile>('a link or base64 bytes', [
    { required: ['link'], read: object((field) => ({ link: text(field('link')) })) },
    { required: ['base64'], read: object((field) => ({ base64: text(field('base64')) })) },
  ]),
);

export const integrityBaseline = object<integrity.IntegrityBaseline>((field) => ({
  head: text(field('head')),
  own: worktreeSnapshot(field('own')),
  idle: keyed(
    object<integrity.IdleSnapshot>((idle) => ({
      generation: count(idle('generation')),
      snapshot: worktreeSnapshot(idle('snapshot')),
    })),
  )(field('idle')),
  untracked: untrackedFiles(field('untracked')),
  tests: untrackedFiles(field('tests')),
}));

const survivor = object<commandCleanup.Survivor>((field) => ({
  pid: count(field('pid')),
  created: nullableText(field('created')),
  commandLine: nullableText(field('commandLine')),
  error: text(field('error')),
}));

const CONTAINMENT: Record<
  commandCleanup.CleanupContainment['kind'],
  recordReadNode.Read<commandCleanup.CleanupContainment>
> = {
  job: object((field) => ({ kind: oneOf({ job: true })(field('kind')) })),
  none: object((field) => ({ kind: oneOf({ none: true })(field('kind')) })),
  group: object((field) => ({ kind: oneOf({ group: true })(field('kind')), pgid: count(field('pgid')) })),
};
const containment = tagged('kind', (kind) => CONTAINMENT[oneOf(CONTAINMENT)(kind)]);

export const savedCleanup = object<commandCleanup.SavedCleanup>((field) => ({
  confirmed: flag(field('confirmed')),
  survivors: list(survivor)(field('survivors')),
  reason: nullableText(field('reason')),
  containment: containment(field('containment')),
}));

const callCleanup = object<commandCleanup.CallCleanup>((field, has) => ({
  confirmed: flag(field('confirmed')),
  survivors: list(survivor)(field('survivors')),
  ...(has('reason') && { reason: nullableText(field('reason')) }),
  ...(has('containment') && { containment: containment(field('containment')) }),
}));

const checkSignal = object<visit.CheckSignal>((field) => ({
  id: text(field('id')),
  kind: text(field('kind')),
  state: oneOf<visit.CheckSignal['state']>({ passed: true, failed: true })(field('state')),
  tree: nullableText(field('tree')),
}));

const checkRun = object<visit.CheckRun>((field) => ({
  output: nullableText(field('output')),
  reason: nullableText(field('reason')),
  failure: nullableText(field('failure')),
  recoverable: flag(field('recoverable')),
}));

const usage = keyed(nullableCount);
const callStatus = oneOf<visit.CallSignal['status']>({
  completed: true,
  failed: true,
  'timed-out': true,
  killed: true,
});

const harnessResult = object<runContext.HarnessResult>((field, has) => ({
  status: callStatus(field('status')),
  sessionId: nullableText(field('sessionId')),
  transcriptPath: nullableText(field('transcriptPath')),
  usage: object((usages) => ({ cumulative: usage(usages('cumulative')), delta: usage(usages('delta')) }))(
    field('usage'),
  ),
  ...(has('exitCode') && { exitCode: nullableCount(field('exitCode')) }),
  ...(has('exitSignal') && { exitSignal: nullableText(field('exitSignal')) }),
  ...(has('finalEventSubtype') && { finalEventSubtype: nullableText(field('finalEventSubtype')) }),
  ...(has('sessionInit') && { sessionInit: json(field('sessionInit')) }),
  ...(has('permissionDenials') && { permissionDenials: json(field('permissionDenials')) }),
  ...(has('commandsRun') && { commandsRun: json(field('commandsRun')) }),
  ...(has('cleanup') && { cleanup: callCleanup(field('cleanup')) }),
}));

const harnessFailure = object<visit.HarnessFailure>((field, has) => ({
  failureClass: text(field('failureClass')),
  ...(has('retryAfterMs') && { retryAfterMs: nullableCount(field('retryAfterMs')) }),
  ...(has('message') && { message: text(field('message')) }),
}));

const agentCall = object<visit.AgentCall>((field) => ({
  harnessResult: harnessResult(field('harnessResult')),
  claim: object<visit.ClaimSignal>((claim) => ({
    valid: flag(claim('valid')),
    token: nullableText(claim('token')),
    reason: nullableText(claim('reason')),
  }))(field('claim')),
  response: json(field('response')),
  baseline: integrityBaseline(field('baseline')),
  signal: object<visit.CallSignal>((signal) => ({
    status: callStatus(signal('status')),
    response: json(signal('response')),
    failure: nullable(harnessFailure)(signal('failure')),
  }))(field('signal')),
}));

const FIXED_ROW: Record<visit.FixedRow, true> = {
  'cleanup-unconfirmed': true,
  'integrity-violation': true,
  'transient-retry': true,
  'transient-exhausted': true,
  'run-stop': true,
  'timeout-retry': true,
  'timeout-exhausted': true,
  'unknown-failure': true,
  'parse-retry': true,
  'parse-exhausted': true,
  claimed: true,
  recover: true,
};
const direction = oneOf<visit.Direction>({ advance: true, retry: true, stop: true });
const retryKind = oneOf<NonNullable<visit.TableResolution['retryKind']>>({
  parse: true,
  timeout: true,
  transient: true,
  rateLimited: true,
});
const decided = (field: (key: string) => recordReadNode.Node) => ({
  outcome: text(field('outcome')),
  direction: direction(field('direction')),
  rule: ruleIdentity(field('rule')),
});

const tableResolution = object<visit.TableResolution>((field, has) => ({
  ...decided(field),
  row: nullable(oneOf(FIXED_ROW))(field('row')),
  check: nullableText(field('check')),
  retryAfterMs: nullableCount(field('retryAfterMs')),
  retryKind: nullable(retryKind)(field('retryKind')),
  failureClass: nullableText(field('failureClass')),
  ...(has('sessionId') && { sessionId: nullableText(field('sessionId')) }),
  ...(has('reason') && { reason: nullableText(field('reason')) }),
  ...(has('surfaces') && { surfaces: nullable(list(text))(field('surfaces')) }),
  ...(has('attempt') && { attempt: count(field('attempt')) }),
  ...(has('signal') && { signal: checkSignal(field('signal')) }),
  ...(has('output') && { output: nullableText(field('output')) }),
}));

// gg's own rows, each its own Resolution; any other row is the Transition Table's, a fixed row or a Procedure's (null).
const OWN_ROW: Record<
  Exclude<visit.Resolution['row'], visit.TableResolution['row']>,
  recordReadNode.Read<visit.Resolution>
> = {
  'effect-completed': object((field) => ({
    ...decided(field),
    row: oneOf({ 'effect-completed': true })(field('row')),
  })),
  decision: object((field) => ({ ...decided(field), row: oneOf({ decision: true })(field('row')) })),
  'action-cap': object((field) => ({
    ...decided(field),
    row: oneOf({ 'action-cap': true })(field('row')),
    actionCap: count(field('actionCap')),
  })),
  'run-stopped': object((field) => ({
    ...decided(field),
    row: oneOf({ 'run-stopped': true })(field('row')),
    failureClass: text(field('failureClass')),
    runStopTicket: count(field('runStopTicket')),
    source: nullableText(field('source')),
  })),
};
const resolution = tagged('row', (row) =>
  typeof row.value === 'string' && Object.hasOwn(OWN_ROW, row.value) ? OWN_ROW[oneOf(OWN_ROW)(row)] : tableResolution,
);

export const visitState = object<recordJson.VisitStateJson>((field) => ({
  recovery: count(field('recovery')),
  firstAttemptBaseline: nullable(integrityBaseline)(field('firstAttemptBaseline')),
  call: nullable(agentCall)(field('call')),
  response: json(field('response')),
  runs: keyed(checkRun)(field('runs')),
  checks: keyed(checkSignal)(field('checks')),
  checkFollows: flag(field('checkFollows')),
  settled: nullable(
    object((settled) => ({
      action: text(settled('action')),
      recovery: count(settled('recovery')),
      resolution: resolution(settled('resolution')),
    })),
  )(field('settled')),
  unconfirmedCleanup: nullable(savedCleanup)(field('unconfirmedCleanup')),
}));

const vertexInput = object<visit.VertexInput>((field) => ({
  value: json(field('value')),
  vertex: nullableText(field('vertex')),
  visit: nullableCount(field('visit')),
  action: nullableText(field('action')),
  absent: flag(field('absent')),
}));

export const configurationSnapshot = object<visit.ConfigurationSnapshot>((field) => ({
  vertex: text(field('vertex')),
  visit: count(field('visit')),
  agent: nullable(
    object((agent, _has, rest) => ({
      harness: text(agent('harness')),
      model: nullableText(agent('model')),
      effort: nullableText(agent('effort')),
      persona: text(agent('persona')),
      ...rest(),
    })),
  )(field('agent')),
  access: text(field('access')),
  procedure: object((procedure) => ({ name: text(procedure('name')), hash: text(procedure('hash')) }))(
    field('procedure'),
  ),
  outcomes: json(field('outcomes')),
  route: json(field('route')),
  routes: json(field('routes')),
  inputs: keyed(vertexInput)(field('inputs')),
  commands: keyed(json)(field('commands')),
  testPaths: list(text)(field('testPaths')),
  persona: nullable(
    object((persona) => ({
      name: text(persona('name')),
      bytes: text(persona('bytes')),
      hash: text(persona('hash')),
    })),
  )(field('persona')),
}));

const actionOutputValue = object<visit.ActionOutputValue>((field, has) => ({
  ...(has('response') && { response: json(field('response')) }),
  ...(has('cleanup') && { cleanup: callCleanup(field('cleanup')) }),
  ...(has('evidence') && {
    evidence: object((evidence, _has, rest) => ({
      command: text(evidence('command')),
      output: text(evidence('output')),
      ...rest(),
    }))(field('evidence')),
  }),
  ...(has('findingsHash') && { findingsHash: text(field('findingsHash')) }),
  ...(has('files') && { files: list(text)(field('files')) }),
  ...(has('decision') && {
    decision: object((decision, hasKey) => ({
      outcome: text(decision('outcome')),
      actor: hasKey('actor') ? text(decision('actor')) : undefined,
      reply: nullableText(decision('reply')),
    }))(field('decision')),
  }),
  ...(has('ref') && { ref: text(field('ref')) }),
  ...(has('diffStat') && {
    diffStat: object((stat) => ({
      files: count(stat('files')),
      insertions: count(stat('insertions')),
      deletions: count(stat('deletions')),
      testFiles: count(stat('testFiles')),
      testInsertions: count(stat('testInsertions')),
    }))(field('diffStat')),
  }),
  ...(has('output') && { output: text(field('output')) }),
}));

export const actionOutput = object<visit.ActionOutput>((field) => ({
  vertex: text(field('vertex')),
  visit: count(field('visit')),
  action: text(field('action')),
  value: actionOutputValue(field('value')),
}));
