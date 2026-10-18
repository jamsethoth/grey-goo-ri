import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as labels from '../lib/labels.mjs';
import { fileURLToPath } from 'node:url';

test('label names carry the configured prefix and family', () => {
  const gg = labels.labels('gg');
  assert.equal(gg.state('in-progress'), 'gg:state:in-progress');
  assert.equal(gg.await('qa-approval'), 'gg:await:qa-approval');
  assert.equal(gg.decide('qa-approval', 'approved'), 'gg:decide:qa-approval:approved');
  assert.equal(labels.labels('x').decide('qa-approval', 'needs-changes'), 'x:decide:qa-approval:needs-changes');
  assert.equal(labels.labels().state('needs-human'), 'gg:state:needs-human');
  assert.deepEqual(labels.STATE_LABELS, ['in-progress', 'needs-human', 'ready-for-qa', 'needs-replan']);
  assert.deepEqual([...labels.BUSY_STATES].sort(), [...labels.STATE_LABELS].sort());
});

test('parse recognises state, await and decide labels and rejects others', () => {
  for (const prefix of ['gg', 'x']) {
    const l = labels.labels(prefix);
    assert.deepEqual(l.parse(l.state('needs-replan')), { family: 'state', name: 'needs-replan' });
    assert.deepEqual(l.parse(l.await('plan-approval')), { family: 'await', vertex: 'plan-approval' });
    assert.deepEqual(l.parse(l.decide('qa-approval', 'needs-changes')), { family: 'decide', vertex: 'qa-approval', outcome: 'needs-changes' });
  }
  const gg = labels.labels('gg');
  assert.equal(gg.parse('in-progress'), null);
  assert.equal(gg.parse('plan-approved'), null);
  assert.equal(gg.parse('ff:ticket'), null);
  assert.equal(gg.parse('x:state:in-progress'), null);
  assert.equal(gg.parse('gg:other:thing'), null);
  assert.equal(gg.parse('gg:decide:qa-approval'), null);
});
test('Label names never expose the local installation directory in a configured prefix', () => {
  const directory = fileURLToPath(new URL('../', import.meta.url));
  const names = labels.labels(directory);
  for (const name of [names.state('in-progress'), names.await('qa'), names.decide('qa', 'approved')]) {
    assert.ok(!name.includes(directory), name);
  }
});
