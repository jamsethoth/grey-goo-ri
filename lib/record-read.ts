// A record's row read field by field into the types lib/record-json.ts saves, so tsc checks every value it gives and
// no assertion types the row (#357). A field of the wrong type, a required key left out, a key the type does not
// declare or a string outside its closed set is a RowFieldError naming its path, which parseRow makes a corrupt row.
import type * as approval from './approval.ts';
import type * as integrity from './integrity.ts';
import type * as outcome from './outcome.ts';
import type * as record from './record.ts';
import type * as recordJson from './record-json.ts';
import type * as visit from './visit.ts';
import type * as writeAhead from './write-ahead.ts';
import * as recordReadVisit from './record-read-visit.ts';
import * as recordReadNode from './record-read-node.ts';

export { RowFieldError } from './record-read-node.ts';

const { text, count, flag, json, nullable, list, keyed, oneOf, object, variant } = recordReadNode;
const { ruleIdentity, historyItem, worktreeSnapshot, untrackedFiles, integrityBaseline } = recordReadVisit;
const nullableText = nullable(text);
const nullableCount = nullable(count);
const texts = list(text);

// Exactly one form, told apart by its keys (record.DecidedBy).
const decidedBy = variant<record.DecidedBy>('one form of decidedBy', [
  { required: ['hold'], read: object((field) => ({ hold: nullableText(field('hold')) })) },
  { required: ['human'], read: object((field) => ({ human: text(field('human')) })) },
  {
    required: ['vertex', 'visit', 'action', 'recovery'],
    read: object((field) => ({
      vertex: text(field('vertex')),
      visit: nullableCount(field('visit')),
      action: nullableText(field('action')),
      recovery: count(field('recovery')),
    })),
  },
]);

const terminalReason = object<record.TerminalReason>((field) => ({
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

const terminalStop = object<record.TerminalStop>((field) => ({
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

const admissionStop = object<record.AdmissionStop>((field) => ({
  kind: oneOf<record.AdmissionStop['kind']>({ hold: true, abandon: true, fault: true })(field('kind')),
  name: nullableText(field('name')),
  terminalReasonText: nullableText(field('terminalReasonText')),
  fresh: flag(field('fresh')),
  advice: nullableText(field('advice')),
  detail: nullableText(field('detail')),
  inProgress: flag(field('inProgress')),
  error: nullableText(field('error')),
}));

const cursor = object<record.Cursor>((field) => ({
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

const retries = object<record.ExecutionRecord['retries'][string]>((field, has) => ({
  ...(has('parse') && { parse: count(field('parse')) }),
  ...(has('timeout') && { timeout: count(field('timeout')) }),
  ...(has('transient') && { transient: count(field('transient')) }),
  ...(has('rateLimited') && { rateLimited: count(field('rateLimited')) }),
  ...(has('remote') && { remote: remoteRetry(field('remote')) }),
}));

const session = object<record.SessionEntry>((field) => ({
  sessionId: nullableText(field('sessionId')),
  harness: text(field('harness')),
  personaHash: text(field('personaHash')),
  transcriptPath: nullableText(field('transcriptPath')),
  cumulativeUsage: keyed(nullableCount)(field('cumulativeUsage')),
  vertex: text(field('vertex')),
  model: nullableText(field('model')),
  effort: nullableText(field('effort')),
  personaName: text(field('personaName')),
}));

const pendingInstance = object<approval.PendingInstance>((field) => ({
  id: text(field('id')),
  execution: text(field('execution')),
  vertex: text(field('vertex')),
  visit: count(field('visit')),
  nonce: text(field('nonce')),
  digest: text(field('digest')),
}));

const label = (field: (key: string) => recordReadNode.Node) => ({
  ticket: count(field('ticket')),
  add: texts(field('add')),
  remove: texts(field('remove')),
});

// The pathspecs a reset intent saved before #144 are a list.
const within: recordReadNode.Read<integrity.Within> = (node) =>
  Array.isArray(node.value)
    ? texts(node)
    : object((field, has) => ({
        ...(has('paths') && { paths: texts(field('paths')) }),
        ...(has('globs') && { globs: texts(field('globs')) }),
        ...(has('exclude') && { exclude: texts(field('exclude')) }),
      }))(node);

const rollbackSet = object<integrity.RollbackSet>((field, has) => ({
  files: untrackedFiles(field('files')),
  ...(has('within') && { within: within(field('within')) }),
  ...(has('pathspecs') && { pathspecs: texts(field('pathspecs')) }),
}));

// What an intent saves: an Effect's payload, a consumed Decision's or an agent call's baseline. Each fits one form by
// its keys; which Effect an entry names is not checked against it (#384).
const PAYLOADS: recordReadNode.Form<writeAhead.Payload>[] = [
  {
    required: ['message', 'tree', 'parent'],
    read: object((field) => ({
      message: text(field('message')),
      tree: text(field('tree')),
      parent: text(field('parent')),
    })),
  },
  {
    required: ['branch', 'sha'],
    read: object((field) => ({ branch: text(field('branch')), sha: text(field('sha')) })),
  },
  {
    required: ['target', 'body', 'bodyHash'],
    read: object((field) => ({
      target: object((target) => ({ kind: text(target('kind')), number: count(target('number')) }))(field('target')),
      body: text(field('body')),
      bodyHash: text(field('bodyHash')),
    })),
  },
  {
    required: ['branch', 'title', 'body', 'bodyHash'],
    optional: ['base'],
    read: object((field, has) => ({
      branch: text(field('branch')),
      ...(has('base') && { base: text(field('base')) }),
      title: text(field('title')),
      body: text(field('body')),
      bodyHash: text(field('bodyHash')),
    })),
  },
  {
    required: ['number', 'sha', 'tree'],
    read: object((field) => ({
      number: count(field('number')),
      sha: nullableText(field('sha')),
      tree: nullableText(field('tree')),
    })),
  },
  { required: ['ticket', 'add', 'remove'], read: object(label) },
  {
    required: ['ticket', 'add', 'remove', 'decision'],
    read: object((field) => ({
      ...label(field),
      decision: object((decision, has) => ({
        instance: text(decision('instance')),
        event: count(decision('event')),
        actor: has('actor') ? text(decision('actor')) : undefined,
        time: text(decision('time')),
        outcome: text(decision('outcome')),
        next: text(decision('next')),
        reply: nullableText(decision('reply')),
      }))(field('decision')),
    })),
  },
  {
    required: ['ref', 'commit', 'tree', 'parent', 'left'],
    read: object((field) => ({
      ref: text(field('ref')),
      commit: text(field('commit')),
      tree: text(field('tree')),
      parent: text(field('parent')),
      left: worktreeSnapshot(field('left')),
    })),
  },
  {
    required: ['baseline', 'history'],
    optional: ['untracked', 'left'],
    read: object((field, has) => ({
      baseline: text(field('baseline')),
      history: historyItem(field('history')),
      ...(has('untracked') && { untracked: rollbackSet(field('untracked')) }),
      // A reset intent saved before the index was fingerprinted has no `index`.
      ...(has('left') && {
        left: object((left, hasKey) => ({
          head: text(left('head')),
          tree: text(left('tree')),
          ...(hasKey('index') && { index: text(left('index')) }),
          ...(hasKey('files') && { files: untrackedFiles(left('files')) }),
        }))(field('left')),
      }),
    })),
  },
  { required: ['baseline'], read: object((field) => ({ baseline: integrityBaseline(field('baseline')) })) },
];

const writeAheadEntry = object<writeAhead.WriteAheadEntry>((field) => ({
  step: oneOf<writeAhead.WriteAheadEntry['step']>({ intent: true, evidence: true, complete: true })(field('step')),
  actionMarker: text(field('actionMarker')),
  effect: nullableText(field('effect')),
  payload: nullable(variant('a write-ahead payload', PAYLOADS))(field('payload')),
  evidence: nullable(keyed(json))(field('evidence')),
  time: text(field('time')),
}));

export const executionRecord = object<recordJson.ExecutionRecordJson>((field) => ({
  schemaVersion: count(field('schemaVersion')),
  repository: text(field('repository')),
  execution: text(field('execution')),
  ticket: count(field('ticket')),
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
  history: list<visit.HistoryItem>(historyItem)(field('history')),
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

export const epicRecord = object<Omit<record.EpicRecord, 'commonDir'>>((field) => ({
  schemaVersion: count(field('schemaVersion')),
  epic: count(field('epic')),
  planDecision: json(field('planDecision')),
  approvalRequest: nullable(pendingInstance)(field('approvalRequest')),
}));
