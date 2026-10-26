import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as labels from '../../lib/labels.mjs';

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

// GitHub matches label names case-insensitively, so a human's differently cased label is the same label (request 3.5).
test('label membership ignores case across every family and configured prefix', () => {
  for (const prefix of ['gg', 'Gg', 'X']) {
    const l = labels.labels(prefix);
    for (const name of [...labels.STATE_LABELS.map(l.state), l.await('plan-approval'), l.decide('qa-approval', 'needs-changes')]) {
      const shown = [name.toUpperCase(), 'unrelated'];
      const set = new Set([name.toLowerCase()]);
      assert.equal(labels.has(shown, name), true, name);
      assert.equal(labels.has(set, name.toUpperCase()), true, name);
      assert.deepEqual(shown, [name.toUpperCase(), 'unrelated'], 'the names keep their spelling');
      assert.deepEqual([...set], [name.toLowerCase()]);
    }
    assert.equal(labels.has([l.state('in-progress')], `Y:state:in-progress`), false, 'another prefix');
    assert.equal(labels.has([l.decide('qa-approval', 'approved')], l.decide('qa-approval', 'needs-changes')), false, 'another outcome');
    assert.equal(labels.has(['in-progress'], l.state('in-progress')), false, 'an unprefixed label');
    assert.equal(labels.has([], l.state('in-progress')), false);
    assert.equal(labels.has(new Set(), l.state('in-progress')), false);
  }
});

test('parse recognises mixed-case prefixes and families without rewriting identifiers', () => {
  for (const prefix of ['gg', 'Gg']) {
    const l = labels.labels(prefix);
    for (const name of labels.STATE_LABELS) {
      assert.deepEqual(l.parse(`GG:STATE:${name.toUpperCase()}`), { family: 'state', name }, name);
    }
    assert.deepEqual(l.parse('gG:Await:Plan-Approval'), { family: 'await', vertex: 'Plan-Approval' });
    assert.deepEqual(l.parse('GG:DECIDE:QA-Approval:Needs-Changes'), { family: 'decide', vertex: 'QA-Approval', outcome: 'Needs-Changes' });
    assert.equal(l.parse('X:STATE:IN-PROGRESS'), null);
    assert.equal(l.parse('IN-PROGRESS'), null);
    assert.equal(l.parse('GG:OTHER:thing'), null);
    assert.equal(l.parse('GG:DECIDE:qa-approval'), null);
    assert.equal(l.parse('GG:STATE:in-progress:extra'), null);
  }
});

// A narrow guard: these are the comparison forms the case-insensitive fix replaced.
test('production label comparisons use the shared helper', () => {
  const lib = new URL('../../lib/', import.meta.url);
  const banned = [/issueLabels\.includes\(/, /labelNames\([^)]*\)\.includes\(/, /busy\.includes\(/, /payload\.add\.includes\(/, /\.label\??\.name\s*===/];
  for (const file of readdirSync(lib).filter((f) => f.endsWith('.mjs'))) {
    const source = readFileSync(new URL(file, lib), 'utf8');
    for (const pattern of banned) assert.doesNotMatch(source, pattern, file);
  }
});
