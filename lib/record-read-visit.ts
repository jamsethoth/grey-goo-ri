// The readers of what an Execution Record's row nests for its Visits (lib/visit.ts): the Configuration Snapshot, the
// Visit's progress with its call, Checks and Resolution, each Action's outputs, and the worktree snapshots and cleanup
// reports those hold. Only lib/record-read.ts imports it.
import type * as visit from './visit.ts';
import * as recordReadNode from './record-read-node.ts';
import * as referencePaths from './reference-paths.ts';

const { text, count, flag, json, nullable, list, keyed, oneOf, object, open, variant, tagged } = recordReadNode;
const nullableText = nullable(text);
const nullableCount = nullable(count);

export const ruleIdentity = object((field) => ({
  table: oneOf({ fixed: true, stopped: true, passed: true, failed: true })(field('table')),
  row: nullable((node) => (typeof node.value === 'number' ? count(node) : text(node)))(field('row')),
}));

export const historyItem = object((field) => ({
  kind: text(field('kind')),
  text: text(field('text')),
}));

export const worktreeSnapshot = object((field) => ({
  head: text(field('head')),
  index: text(field('index')),
  tree: text(field('tree')),
}));

// Each a link's target with its kind, or the bytes in base64, told apart by their keys.
export const untrackedFiles = keyed(
  variant('a link or base64 bytes', [
    {
      required: ['link', 'directory'],
      read: object((field) => ({ link: text(field('link')), directory: flag(field('directory')) })),
    },
    { required: ['base64'], read: object((field) => ({ base64: text(field('base64')) })) },
  ]),
);

export const integrityBaseline = object((field) => ({
  head: text(field('head')),
  own: worktreeSnapshot(field('own')),
  idle: keyed(
    object((idle) => ({
      generation: count(idle('generation')),
      snapshot: worktreeSnapshot(idle('snapshot')),
    })),
  )(field('idle')),
  untracked: untrackedFiles(field('untracked')),
  tests: untrackedFiles(field('tests')),
}));

const survivor = object((field) => ({
  pid: count(field('pid')),
  created: nullableText(field('created')),
  commandLine: nullableText(field('commandLine')),
  error: text(field('error')),
}));

const containment = tagged('kind', {
  job: object((field) => ({ kind: oneOf({ job: true })(field('kind')) })),
  none: object((field) => ({ kind: oneOf({ none: true })(field('kind')) })),
  group: object((field) => ({ kind: oneOf({ group: true })(field('kind')), pgid: count(field('pgid')) })),
});

export const savedCleanup = object((field) => ({
  confirmed: flag(field('confirmed')),
  survivors: list(survivor)(field('survivors')),
  reason: nullableText(field('reason')),
  containment: containment(field('containment')),
}));

const callCleanup = object((field, has) => ({
  confirmed: flag(field('confirmed')),
  survivors: list(survivor)(field('survivors')),
  ...(has('reason') && { reason: nullableText(field('reason')) }),
  ...(has('containment') && { containment: containment(field('containment')) }),
}));

const checkSignal = object((field) => ({
  id: text(field('id')),
  kind: text(field('kind')),
  state: oneOf({ passed: true, failed: true })(field('state')),
  tree: nullableText(field('tree')),
}));

const checkRun = object((field) => ({
  output: nullableText(field('output')),
  reason: nullableText(field('reason')),
  failure: nullableText(field('failure')),
  recoverable: flag(field('recoverable')),
}));

// A Usage is closed (#23, Clarify Q2 B): every count, and where a cost figure came from.
export const usage = object((field, has) => ({
  inputTokens: nullableCount(field('inputTokens')),
  cacheReadTokens: nullableCount(field('cacheReadTokens')),
  cacheWriteTokens: nullableCount(field('cacheWriteTokens')),
  outputTokens: nullableCount(field('outputTokens')),
  reasoningTokens: nullableCount(field('reasoningTokens')),
  costUsd: nullableCount(field('costUsd')),
  peakContextTokens: nullableCount(field('peakContextTokens')),
  turns: nullableCount(field('turns')),
  toolCalls: nullableCount(field('toolCalls')),
  compactions: nullableCount(field('compactions')),
  ...(has('costBasis') && { costBasis: nullable(oneOf({ reported: true, priced: true }))(field('costBasis')) }),
}));
const callStatus = oneOf({
  completed: true,
  failed: true,
  'timed-out': true,
  killed: true,
});

const harnessResult = object((field, has) => ({
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
  ...(has('repositoryDigest') && { repositoryDigest: nullableText(field('repositoryDigest')) }),
  ...(has('agentCliVersion') && { agentCliVersion: nullableText(field('agentCliVersion')) }),
  ...(has('effectiveModel') && { effectiveModel: nullableText(field('effectiveModel')) }),
  ...(has('effectiveEffort') && { effectiveEffort: nullableText(field('effectiveEffort')) }),
}));

const harnessFailure = object((field, has) => ({
  failureClass: text(field('failureClass')),
  ...(has('retryAfterMs') && { retryAfterMs: nullableCount(field('retryAfterMs')) }),
  ...(has('message') && { message: text(field('message')) }),
}));

const agentCall = object((field) => ({
  harnessResult: harnessResult(field('harnessResult')),
  claim: object((claim) => ({
    valid: flag(claim('valid')),
    token: nullableText(claim('token')),
    reason: nullableText(claim('reason')),
  }))(field('claim')),
  response: json(field('response')),
  baseline: integrityBaseline(field('baseline')),
  signal: object((signal) => ({
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
const direction = oneOf({ advance: true, retry: true, stop: true });
const retryKind = oneOf({
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

const tableResolution = object((field, has) => ({
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
const resolution = tagged(
  'row',
  {
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
  },
  tableResolution,
);

// An agent call's completion evidence: its Resolution, which the next Attempt reads, beside the Usage the call spent.
export const callEvidence = (node: recordReadNode.Node) => {
  const { value, path } = node;
  // Only an object holding usageDelta is read as one (lib/record-read.ts); any other refuses as a Resolution would.
  const { usageDelta, ...settled } = referencePaths.isRecord(value) ? value : {};
  return {
    ...resolution({ value: settled, path }),
    usageDelta: usage({ value: usageDelta, path: path ? `${path}.usageDelta` : 'usageDelta' }),
  };
};

export const visitState = object((field) => ({
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

const vertexInput = object((field) => ({
  value: json(field('value')),
  vertex: nullableText(field('vertex')),
  visit: nullableCount(field('visit')),
  action: nullableText(field('action')),
  absent: flag(field('absent')),
}));

export const configurationSnapshot = object((field) => ({
  vertex: text(field('vertex')),
  visit: count(field('visit')),
  configHash: text(field('configHash')),
  agent: nullable(
    open((agent, has) => ({
      harness: text(agent('harness')),
      model: nullableText(agent('model')),
      effort: nullableText(agent('effort')),
      persona: text(agent('persona')),
      ...(has('network') && { network: flag(agent('network')) }),
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
  files: keyed(object((file) => ({ bytes: text(file('bytes')), hash: text(file('hash')) })))(field('files')),
}));

const actionOutputValue = object((field, has) => ({
  ...(has('response') && { response: json(field('response')) }),
  ...(has('cleanup') && { cleanup: callCleanup(field('cleanup')) }),
  ...(has('evidence') && {
    evidence: open((evidence, hasEvidence) => ({
      command: text(evidence('command')),
      output: text(evidence('output')),
      ...(hasEvidence('foundByNameOnly') && { foundByNameOnly: flag(evidence('foundByNameOnly')) }),
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

export const actionOutput = object((field) => ({
  vertex: text(field('vertex')),
  visit: count(field('visit')),
  action: text(field('action')),
  value: actionOutputValue(field('value')),
}));
