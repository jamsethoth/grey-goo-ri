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
  assert.deepEqual(labels.STATE_LABELS, ['in-progress', 'ready-for-qa', 'needs-human', 'needs-replan']);
  assert.deepEqual(labels.ENDS, ['ready-for-qa', 'needs-human', 'needs-replan']);
  assert.deepEqual([...labels.BUSY_STATES].sort(), [...labels.STATE_LABELS].sort());
});

for (const [prefix, state, awaiting, decide] of [
  ['gg', 'gg:state:needs-replan', 'gg:await:plan-approval', 'gg:decide:qa-approval:needs-changes'],
  ['x', 'x:state:needs-replan', 'x:await:plan-approval', 'x:decide:qa-approval:needs-changes'],
]) {
  test(`parse with prefix ${prefix} recognises state, await and decide labels`, () => {
    const l = labels.labels(prefix);
    assert.deepEqual(l.parse(state), { family: 'state', name: 'needs-replan' });
    assert.deepEqual(l.parse(awaiting), { family: 'await', vertex: 'plan-approval' });
    assert.deepEqual(l.parse(decide), { family: 'decide', vertex: 'qa-approval', outcome: 'needs-changes' });
  });
}

test('parse rejects labels outside the state, await and decide families of its prefix', () => {
  const gg = labels.labels('gg');
  assert.equal(gg.parse('in-progress'), null);
  assert.equal(gg.parse('plan-approved'), null);
  assert.equal(gg.parse('ff:ticket'), null);
  assert.equal(gg.parse('x:state:in-progress'), null);
  assert.equal(gg.parse('gg:other:thing'), null);
  assert.equal(gg.parse('gg:decide:qa-approval'), null);
});

// GitHub matches label names case-insensitively, so a human's differently cased label is the same label (request 3.5).
for (const name of [
  'gg:state:in-progress', 'gg:state:needs-human', 'gg:state:ready-for-qa', 'gg:state:needs-replan',
  'gg:await:plan-approval', 'gg:decide:qa-approval:needs-changes',
  'Gg:state:in-progress', 'Gg:state:needs-human', 'Gg:state:ready-for-qa', 'Gg:state:needs-replan',
  'Gg:await:plan-approval', 'Gg:decide:qa-approval:needs-changes',
  'X:state:in-progress', 'X:state:needs-human', 'X:state:ready-for-qa', 'X:state:needs-replan',
  'X:await:plan-approval', 'X:decide:qa-approval:needs-changes',
]) {
  test(`label membership of ${name} ignores case and keeps the names' spelling`, () => {
    const shown = [name.toUpperCase(), 'unrelated'];
    const set = new Set([name.toLowerCase()]);
    assert.equal(labels.has(shown, name), true);
    assert.equal(labels.has(set, name.toUpperCase()), true);
    assert.deepEqual(shown, [name.toUpperCase(), 'unrelated'], 'the names keep their spelling');
    assert.deepEqual([...set], [name.toLowerCase()]);
  });
}

for (const [prefix, inProgress, approved, needsChanges] of [
  ['gg', 'gg:state:in-progress', 'gg:decide:qa-approval:approved', 'gg:decide:qa-approval:needs-changes'],
  ['Gg', 'Gg:state:in-progress', 'Gg:decide:qa-approval:approved', 'Gg:decide:qa-approval:needs-changes'],
  ['X', 'X:state:in-progress', 'X:decide:qa-approval:approved', 'X:decide:qa-approval:needs-changes'],
]) {
  test(`label membership with prefix ${prefix} tells another prefix, outcome or an unprefixed label apart`, () => {
    assert.equal(labels.has([inProgress], 'Y:state:in-progress'), false, 'another prefix');
    assert.equal(labels.has([approved], needsChanges), false, 'another outcome');
    assert.equal(labels.has(['in-progress'], inProgress), false, 'an unprefixed label');
    assert.equal(labels.has([], inProgress), false);
    assert.equal(labels.has(new Set(), inProgress), false);
  });
}

for (const [prefix, label, name] of [
  ['gg', 'GG:STATE:IN-PROGRESS', 'in-progress'],
  ['gg', 'GG:STATE:NEEDS-HUMAN', 'needs-human'],
  ['gg', 'GG:STATE:READY-FOR-QA', 'ready-for-qa'],
  ['gg', 'GG:STATE:NEEDS-REPLAN', 'needs-replan'],
  ['Gg', 'GG:STATE:IN-PROGRESS', 'in-progress'],
  ['Gg', 'GG:STATE:NEEDS-HUMAN', 'needs-human'],
  ['Gg', 'GG:STATE:READY-FOR-QA', 'ready-for-qa'],
  ['Gg', 'GG:STATE:NEEDS-REPLAN', 'needs-replan'],
]) {
  test(`parse with prefix ${prefix} reads ${label} as the State Label ${name}`, () => {
    assert.deepEqual(labels.labels(prefix).parse(label), { family: 'state', name });
  });
}

for (const prefix of ['gg', 'Gg']) {
  test(`parse with prefix ${prefix} recognises mixed-case prefixes and families without rewriting identifiers`, () => {
    const l = labels.labels(prefix);
    assert.deepEqual(l.parse('gG:Await:Plan-Approval'), { family: 'await', vertex: 'Plan-Approval' });
    assert.deepEqual(l.parse('GG:DECIDE:QA-Approval:Needs-Changes'), { family: 'decide', vertex: 'QA-Approval', outcome: 'Needs-Changes' });
    assert.equal(l.parse('X:STATE:IN-PROGRESS'), null);
    assert.equal(l.parse('IN-PROGRESS'), null);
    assert.equal(l.parse('GG:OTHER:thing'), null);
    assert.equal(l.parse('GG:DECIDE:qa-approval'), null);
    assert.equal(l.parse('GG:STATE:in-progress:extra'), null);
  });
}

// A narrow guard: these are the comparison forms the case-insensitive fix replaced.
test('production label comparisons use the shared helper', () => {
  const lib = new URL('../../lib/', import.meta.url);
  const banned = [/issueLabels\.includes\(/, /labelNames\([^)]*\)\.includes\(/, /busy\.includes\(/, /payload\.add\.includes\(/, /\.label\??\.name\s*===/];
  for (const file of readdirSync(lib).filter((f) => f.endsWith('.mjs'))) {
    const source = readFileSync(new URL(file, lib), 'utf8');
    for (const pattern of banned) assert.doesNotMatch(source, pattern, file);
  }
});
