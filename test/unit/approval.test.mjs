import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as approval from '../../lib/approval.mjs';

const timeline = (name) => JSON.parse(readFileSync(new URL(`../fixtures/approval/${name}.json`, import.meta.url), 'utf8'));

// The REST collaborator `permission` field: maintain reads as write and triage as read (L5).
const permissions = { owner: 'admin', maintainer: 'write', triager: 'read' };
const approved = { head: 'a'.repeat(40), body: 'Ticket body.\n', configHash: 'c'.repeat(64) };
const pending = () => approval.request({ execution: '7.a1b2c3', vertex: 'qa-approval', visit: 2, nonce: '0f0f', ...approved });

test('a pending instance is named by execution, vertex, visit and nonce', () => {
  const request = approval.request({ execution: '7.a1b2c3', vertex: 'qa-approval', visit: 2, nonce: '0f0f', ...approved });
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
  const read = approval.read({ pending: pending(), timeline: timeline('one-decision'), digest: approval.digest(approved), permissions });
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 300, actor: 'owner', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
  });
});

test('a decision before the request is ignored', () => {
  const read = approval.read({ pending: pending(), timeline: timeline('decision-before-request'), digest: approval.digest(approved), permissions });
  assert.deepEqual(read, { kind: 'waiting' });
});

test('an undone decide label is ignored', () => {
  const read = approval.read({ pending: pending(), timeline: timeline('undone-decision'), digest: approval.digest(approved), permissions });
  assert.deepEqual(read, { kind: 'waiting' });
});

test('a triage-only actor is ignored', () => {
  const read = approval.read({ pending: pending(), timeline: timeline('triage-decision'), digest: approval.digest(approved), permissions });
  assert.deepEqual(read, { kind: 'waiting' });
});

test('an actor in approvers is authorised below write permission', () => {
  const read = approval.read({
    pending: pending(), timeline: timeline('triage-decision'), digest: approval.digest(approved), permissions, approvers: ['Triager'],
  });
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 300, actor: 'triager', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
  });
});

test('two surviving decisions are ambiguous', () => {
  const read = approval.read({ pending: pending(), timeline: timeline('two-decisions'), digest: approval.digest(approved), permissions });
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
  assert.deepEqual(approval.read({ pending: pending(), timeline: timeline('one-decision'), digest, permissions }), { kind: 'stale' });
});

test('a changed ticket body makes the request stale', () => {
  const digest = approval.digest({ ...approved, body: 'Ticket body, edited.\n' });
  assert.deepEqual(approval.read({ pending: pending(), timeline: timeline('one-decision'), digest, permissions }), { kind: 'stale' });
});

test('a changed config hash makes the request stale', () => {
  const digest = approval.digest({ ...approved, configHash: 'd'.repeat(64) });
  assert.deepEqual(approval.read({ pending: pending(), timeline: timeline('one-decision'), digest, permissions }), { kind: 'stale' });
});

test('no pending instance is missing', () => {
  const read = approval.read({ pending: null, timeline: timeline('one-decision'), digest: approval.digest(approved), permissions });
  assert.deepEqual(read, { kind: 'missing' });
});

test('a pending instance without its Await Label event is missing', () => {
  const read = approval.read({ pending: pending(), timeline: timeline('no-request'), digest: approval.digest(approved), permissions });
  assert.deepEqual(read, { kind: 'missing' });
});

test('a mixed-case decide label gives a lowercase outcome', () => {
  const read = approval.read({ pending: pending(), timeline: timeline('mixed-case-decision'), digest: approval.digest(approved), permissions });
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 300, actor: 'owner', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
  });
});

test('a removed Await Label is missing', () => {
  const read = approval.read({ pending: pending(), timeline: timeline('removed-request'), digest: approval.digest(approved), permissions });
  assert.deepEqual(read, { kind: 'missing' });
});

test('an actor\'s permission is found whatever the case of its login', () => {
  const read = approval.read({
    pending: pending(), timeline: timeline('one-decision'), digest: approval.digest(approved), permissions: { OWNER: 'admin' },
  });
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 300, actor: 'owner', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
  });
});

test('a mixed-case actor login finds its permission', () => {
  const read = approval.read({ pending: pending(), timeline: timeline('mixed-case-actor'), digest: approval.digest(approved), permissions });
  assert.deepEqual(read, {
    kind: 'consume',
    decision: { event: 300, actor: 'Owner', time: '2026-10-27T11:00:00Z', outcome: 'approved' },
  });
});
