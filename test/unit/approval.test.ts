import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as approval from '../../lib/approval.ts';

const timeline = (name: string): approval.IssueEvent[] =>
  JSON.parse(readFileSync(new URL(`../fixtures/approval/${name}.json`, import.meta.url), 'utf8'));

// The REST collaborator `permission` field: maintain reads as write and triage as read (L5).
const permissions = { owner: 'admin', maintainer: 'write', triager: 'read' };
// The issue's labels now: the Await Label is on, with or without the approved Decide Label.
const awaiting = ['gg:await:qa-approval'];
const awaitingApproved = ['gg:await:qa-approval', 'gg:decide:qa-approval:approved'];
const approved = { head: 'a'.repeat(40), body: 'Ticket body.\n', configHash: 'c'.repeat(64) };
const pending = () =>
  approval.request({ execution: '7.a1b2c3', vertex: 'qa-approval', visit: 2, nonce: '0f0f', ...approved });

// The issue as most cases read it: the Await Label and the approved Decide Label on, the request pending, the digest
// unchanged; a case passes only the fields it changes.
const readTimeline = (name: string, changes: Partial<Parameters<typeof approval.read>[0]> = {}) =>
  approval.read({
    issueLabels: awaitingApproved,
    approvalRequest: pending(),
    timeline: timeline(name),
    digest: approval.digest(approved),
    permissions,
    ...changes,
  });

test('a pending instance is named by execution, vertex, visit and nonce', () => {
  const request = approval.request({
    execution: '7.a1b2c3',
    vertex: 'qa-approval',
    visit: 2,
    nonce: '0f0f',
    ...approved,
  });
  assert.equal(request.id, '7.a1b2c3:qa-approval:2:0f0f');
  assert.equal(request.vertex, 'qa-approval');
  assert.equal(request.digest, approval.digest(approved));
});

test('two requests for one visit are different pending instances', () => {
  const first = approval.request({ execution: '7.a1b2c3', vertex: 'qa-approval', visit: 2, ...approved });
  const second = approval.request({ execution: '7.a1b2c3', vertex: 'qa-approval', visit: 2, ...approved });
  assert.notEqual(first.id, second.id);
  assert.equal(first.digest, second.digest);
});

test('one authorised decision with a matching digest is consumed', () => {
  const read = readTimeline('one-decision');
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 300, actor: 'owner', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
  });
});

test('a decision before the request is ignored', () => {
  const read = readTimeline('decision-before-request');
  assert.deepEqual(read, { kind: 'waiting' });
});

test('an undone decide label is ignored', () => {
  const read = readTimeline('undone-decision', { issueLabels: awaiting });
  assert.deepEqual(read, { kind: 'waiting' });
});

test('a triage-only actor is ignored', () => {
  const read = readTimeline('triage-decision');
  assert.deepEqual(read, { kind: 'waiting' });
});

test('an actor in approvers is authorised below write permission', () => {
  const read = readTimeline('triage-decision', { approvers: ['Triager'] });
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 300, actor: 'triager', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
  });
});

test('two surviving decisions are ambiguous', () => {
  const read = readTimeline('two-decisions', {
    issueLabels: ['gg:await:qa-approval', 'gg:decide:qa-approval:approved', 'gg:decide:qa-approval:rejected'],
  });
  assert.deepEqual(read, {
    kind: 'ambiguous',
    decisions: [
      { event: 300, actor: 'owner', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
      { event: 301, actor: 'maintainer', time: '2026-10-27T11:01:00Z', outcome: 'rejected' },
    ],
  });
});

test('a changed branch HEAD makes the request stale', () => {
  const digest = approval.digest({ ...approved, head: 'b'.repeat(40) });
  assert.deepEqual(readTimeline('one-decision', { digest }), { kind: 'stale' });
});

test('a changed ticket body makes the request stale', () => {
  const digest = approval.digest({ ...approved, body: 'Ticket body, edited.\n' });
  assert.deepEqual(readTimeline('one-decision', { digest }), { kind: 'stale' });
});

test('a changed config hash makes the request stale', () => {
  const digest = approval.digest({ ...approved, configHash: 'd'.repeat(64) });
  assert.deepEqual(readTimeline('one-decision', { digest }), { kind: 'stale' });
});

test('no pending instance is missing', () => {
  const read = readTimeline('one-decision', { approvalRequest: null });
  assert.deepEqual(read, { kind: 'missing' });
});

test('a pending instance without its Await Label event is missing', () => {
  const read = readTimeline('no-request');
  assert.deepEqual(read, { kind: 'missing' });
});

test('a mixed-case decide label gives a lowercase outcome', () => {
  const read = readTimeline('mixed-case-decision', {
    issueLabels: ['gg:await:qa-approval', 'GG:Decide:QA-Approval:Approved'],
  });
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 300, actor: 'owner', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
  });
});

test('a removed Await Label is missing', () => {
  const read = readTimeline('removed-request', { issueLabels: ['gg:decide:qa-approval:approved'] });
  assert.deepEqual(read, { kind: 'missing' });
});

test("an actor's permission is found whatever the case of its login", () => {
  const read = readTimeline('one-decision', { permissions: { OWNER: 'admin' } });
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 300, actor: 'owner', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
  });
});

test('a mixed-case actor login finds its permission', () => {
  const read = readTimeline('mixed-case-actor');
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 300, actor: 'Owner', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
  });
});

test('events are read in time order, not list order', () => {
  const read = readTimeline('out-of-order');
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 300, actor: 'owner', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
  });
});

test('events in one second keep their listed order', () => {
  const read = readTimeline('same-second-decision-first');
  assert.deepEqual(read, { kind: 'waiting' });
});

test('a request listed before its retirement in the same second is still the request', () => {
  const read = readTimeline('same-second-retire', {
    issueLabels: ['gg:await:qa-approval', 'gg:decide:qa-approval:approved', 'gg:decide:qa-approval:needs-changes'],
  });
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 300, actor: 'owner', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
  });
});

test('a decide label removed in the same second, listed first, is ignored', () => {
  const read = readTimeline('same-second-undo', { issueLabels: awaiting });
  assert.deepEqual(read, { kind: 'waiting' });
});

test('a decide label removed and applied again is one decision', () => {
  const read = readTimeline('reapplied-decision');
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 302, actor: 'owner', time: '2026-10-27T12:00:00Z', outcome: 'approved' },
  });
});

test('an Await Label removal is never the request', () => {
  const read = readTimeline('only-removed-request');
  assert.deepEqual(read, { kind: 'missing' });
});

test('a Decide Label for an Outcome the request does not declare is not a Decision', () => {
  const result = readTimeline('one-decision', { decisions: ['rejected'] });
  assert.deepEqual(result, { kind: 'waiting' });
});

test('the actors a read needs permissions for are those of Decide Labels for its Vertex', () => {
  assert.deepEqual(approval.decidingActors({ vertex: 'qa-approval', timeline: timeline('one-decision') }), ['owner']);
  assert.deepEqual(approval.decidingActors({ vertex: 'another', timeline: timeline('one-decision') }), []);
});
