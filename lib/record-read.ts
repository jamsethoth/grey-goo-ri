// A record's row read field by field into the types lib/record-json.ts saves, so tsc checks every value it gives and
// no assertion types the row (#357). Those types are the row's one declaration: each reader's type is inferred from
// what it reads, and tsc holds it to its record type both ways (test/unit/record-read.test.ts, #402). A field of the
// wrong type, a required key left out, a key the type does not declare or a string outside its closed set is a
// RowFieldError naming its path, which parseRow makes a corrupt row.
import type * as outcome from './outcome.ts';
import * as recordReadVisit from './record-read-visit.ts';
import * as recordReadNode from './record-read-node.ts';
import * as referencePaths from './reference-paths.ts';
import * as effects from './effects/index.ts';
import * as writeAhead from './write-ahead.ts';

export { RowFieldError } from './record-read-node.ts';

const { text, count, flag, json, nullable, list, keyed, oneOf, object, variant } = recordReadNode;
const { ruleIdentity, historyItem, usage } = recordReadVisit;
const nullableText = nullable(text);
const nullableCount = nullable(count);
const texts = list(text);

const ACTION_KEYS = ['vertex', 'visit', 'action', 'recovery'];
const actionKeys = (field: (key: string) => recordReadNode.Node) => ({
  vertex: text(field('vertex')),
  visit: nullableCount(field('visit')),
  action: nullableText(field('action')),
  recovery: count(field('recovery')),
});

// Exactly one form, told apart by its keys (record.DecidedBy). A hold or an abandonment that cut a Visit off names it
// with an Action's keys, all four or none (#341).
const decidedBy = variant('one form of decidedBy', [
  { required: ['hold'], read: object((field) => ({ hold: nullableText(field('hold')) })) },
  {
    required: ['hold', ...ACTION_KEYS],
    read: object((field) => ({ hold: nullableText(field('hold')), ...actionKeys(field) })),
  },
  { required: ['label'], read: object((field) => ({ label: text(field('label')) })) },
  {
    required: ['label', ...ACTION_KEYS],
    read: object((field) => ({ label: text(field('label')), ...actionKeys(field) })),
  },
  { required: ACTION_KEYS, read: object(actionKeys) },
  { required: ['human'], read: object((field) => ({ human: text(field('human')) })) },
]);

const terminalReason = object((field) => ({
  decidedBy: decidedBy(field('decidedBy')),
  outcome: nullableText(field('outcome')),
  rule: nullable(ruleIdentity)(field('rule')),
  text: text(field('text')),
}));

const actionIdentity = object((field, has) => ({
  vertex: text(field('vertex')),
  visit: count(field('visit')),
  ...(has('procedure') && { procedure: nullableText(field('procedure')) }),
  action: text(field('action')),
  recovery: count(field('recovery')),
  ...(has('attempt') && { attempt: count(field('attempt')) }),
}));

const terminalStop = object((field) => ({
  outcome: text(field('outcome')),
  response: json(field('response')),
  actionRef: nullable(actionIdentity)(field('actionRef')),
  held: flag(field('held')),
  abandoned: flag(field('abandoned')),
  inProgress: flag(field('inProgress')),
  fresh: flag(field('fresh')),
  stopped: flag(field('stopped')),
  commentTemplate: nullableText(field('commentTemplate')),
  advice: nullableText(field('advice')),
  detail: nullableText(field('detail')),
  error: nullableText(field('error')),
  failureClass: nullableText(field('failureClass')),
  interrupted: nullable(
    object((interrupted) => ({
      terminal: text(interrupted('terminal')),
      terminalReason: terminalReason(interrupted('terminalReason')),
    })),
  )(field('interrupted')),
}));

const admissionStop = object((field) => ({
  kind: oneOf({ hold: true, abandon: true, fault: true })(field('kind')),
  name: nullableText(field('name')),
  terminalReasonText: nullableText(field('terminalReasonText')),
  fresh: flag(field('fresh')),
  advice: nullableText(field('advice')),
  detail: nullableText(field('detail')),
  inProgress: flag(field('inProgress')),
  error: nullableText(field('error')),
}));

const cursor = object((field) => ({
  vertex: text(field('vertex')),
  visit: nullableCount(field('visit')),
  action: nullableText(field('action')),
  recovery: count(field('recovery')),
  attempt: count(field('attempt')),
}));

const FAILURE_CLASS: Record<outcome.FailureClass, true> = {
  transient: true,
  'rate-limited': true,
  auth: true,
  quota: true,
  budget: true,
  permission: true,
  rejected: true,
  invalid: true,
  unknown: true,
};

const remoteRetry = object((field) => ({
  count: count(field('count')),
  failureClass: nullable(oneOf(FAILURE_CLASS))(field('failureClass')),
  nextEligibleAt: count(field('nextEligibleAt')),
  started: flag(field('started')),
}));

const retries = object((field, has) => ({
  ...(has('parse') && { parse: count(field('parse')) }),
  ...(has('timeout') && { timeout: count(field('timeout')) }),
  ...(has('transient') && { transient: count(field('transient')) }),
  ...(has('rateLimited') && { rateLimited: count(field('rateLimited')) }),
  ...(has('crash') && { crash: count(field('crash')) }),
  ...(has('handoff') && { handoff: count(field('handoff')) }),
  ...(has('remote') && { remote: remoteRetry(field('remote')) }),
}));

const handedOffSession = object((field) => ({
  sessionId: nullableText(field('sessionId')),
  transcriptPath: nullableText(field('transcriptPath')),
  cumulativeUsage: usage(field('cumulativeUsage')),
  attempt: count(field('attempt')),
}));
const session = object((field, has) => ({
  sessionId: nullableText(field('sessionId')),
  harness: text(field('harness')),
  personaHash: text(field('personaHash')),
  transcriptPath: nullableText(field('transcriptPath')),
  cumulativeUsage: usage(field('cumulativeUsage')),
  vertex: text(field('vertex')),
  model: nullableText(field('model')),
  effort: nullableText(field('effort')),
  personaName: text(field('personaName')),
  ...(has('handedOff') && { handedOff: list(handedOffSession)(field('handedOff')) }),
}));

const pendingInstance = object((field) => ({
  id: text(field('id')),
  execution: text(field('execution')),
  vertex: text(field('vertex')),
  visit: count(field('visit')),
  nonce: text(field('nonce')),
  digest: text(field('digest')),
}));

// An intent's payload, read by its effect's reader: the one form that effect saves (#384). An intent naming an effect
// this gg does not know loads holding whichever form it fits, for Reconciliation to hold (record.md); every form's
// keys are its own, so it fits one at most.
const anyPayload: recordReadNode.Read<writeAhead.Payload> = (node) => {
  if (!referencePaths.isRecord(node.value)) throw new recordReadNode.RowFieldError(node, 'is not an object');
  for (const read of [writeAhead.readCallPayload, ...effects.all().map((effect) => effect.readPayload)]) {
    try {
      return read(node);
    } catch (err) {
      if (!(err instanceof recordReadNode.RowFieldError)) throw err;
    }
  }
  throw new recordReadNode.RowFieldError(node, 'is not a write-ahead payload');
};
const intentPayload = (effect: string | null): recordReadNode.Read<writeAhead.Payload> =>
  effect === 'call' ? writeAhead.readCallPayload : (effects.lookup(effect)?.readPayload ?? anyPayload);
// Evidence and completion carry no payload (#384).
const noPayload: recordReadNode.Read<null> = (node) => {
  if (node.value === null) return null;
  throw new recordReadNode.RowFieldError(node, 'is not null outside an intent');
};

// What an Effect leaves as Evidence, one form per Effect told apart by its keys (effects.Evidence), or an agent call's,
// which holds the Usage it spent.
const EFFECT_EVIDENCE = [
  { required: ['sha'], read: object((field) => ({ sha: nullableText(field('sha')) })) },
  { required: ['remoteSha'], read: object((field) => ({ remoteSha: text(field('remoteSha')) })) },
  { required: ['id'], read: object((field) => ({ id: count(field('id')) })) },
  {
    required: ['number', 'url'],
    read: object((field) => ({ number: count(field('number')), url: text(field('url')) })),
  },
  { required: [], read: object((): Record<string, never> => ({})) },
  { required: ['ok'], read: object((field) => ({ ok: flag(field('ok')) })) },
  {
    required: ['ref', 'commit'],
    read: object((field) => ({ ref: text(field('ref')), commit: text(field('commit')) })),
  },
  { required: ['head'], read: object((field) => ({ head: text(field('head')) })) },
];
const evidence = (node: recordReadNode.Node) =>
  referencePaths.isRecord(node.value) && Object.hasOwn(node.value, 'usageDelta')
    ? recordReadVisit.callEvidence(node)
    : variant("an Effect's evidence", EFFECT_EVIDENCE)(node);

// Typed whole: inferred, its payload's union would lose a consumed Decision's form into the label form it extends.
const writeAheadEntry: recordReadNode.Read<writeAhead.WriteAheadEntry> = object((field) => {
  const step = oneOf({ intent: true, evidence: true, complete: true })(field('step'));
  const actionMarker = text(field('actionMarker'));
  const effect = nullableText(field('effect'));
  return {
    step,
    actionMarker,
    effect,
    payload: (step === 'intent' ? intentPayload(effect) : noPayload)(field('payload')),
    evidence: nullable(evidence)(field('evidence')),
    time: text(field('time')),
  };
});

export const executionRecord = object((field) => ({
  schemaVersion: count(field('schemaVersion')),
  repository: text(field('repository')),
  execution: text(field('execution')),
  ticket: count(field('ticket')),
  owner: object((owner) => ({
    kind: oneOf({ ticket: true, epic: true })(owner('kind')),
    number: count(owner('number')),
  }))(field('owner')),
  epic: nullableCount(field('epic')),
  flow: text(field('flow')),
  configHash: text(field('configHash')),
  run: text(field('run')),
  state: text(field('state')),
  terminalReason: nullable(terminalReason)(field('terminalReason')),
  terminalStop: nullable(terminalStop)(field('terminalStop')),
  admissionStop: nullable(admissionStop)(field('admissionStop')),
  cursor: cursor(field('cursor')),
  visits: keyed(count)(field('visits')),
  traversals: keyed(count)(field('traversals')),
  retries: keyed(retries)(field('retries')),
  sessions: keyed(session)(field('sessions')),
  attempts: count(field('attempts')),
  outputs: list(recordReadVisit.actionOutput)(field('outputs')),
  testCommits: object((commits) => ({
    first: nullableText(commits('first')),
    baseline: nullableText(commits('baseline')),
  }))(field('testCommits')),
  history: list(historyItem)(field('history')),
  worktree: text(field('worktree')),
  branch: text(field('branch')),
  base: text(field('base')),
  pr: nullableCount(field('pr')),
  approvalRequest: nullable(pendingInstance)(field('approvalRequest')),
  configurationSnapshot: nullable(recordReadVisit.configurationSnapshot)(field('configurationSnapshot')),
  visitState: nullable(recordReadVisit.visitState)(field('visitState')),
  activity: object((activity) => ({ busy: flag(activity('busy')), generation: count(activity('generation')) }))(
    field('activity'),
  ),
  heartbeat: nullableText(field('heartbeat')),
  writeAheadLog: list(writeAheadEntry)(field('writeAheadLog')),
}));

export const epicRecord = object((field) => ({
  schemaVersion: count(field('schemaVersion')),
  epic: count(field('epic')),
  planDecision: json(field('planDecision')),
  approvalRequest: nullable(pendingInstance)(field('approvalRequest')),
}));
