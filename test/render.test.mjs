import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as render from '../lib/render.mjs';
import * as marker from '../lib/marker.mjs';

const parts = { execution: 'e1', vertex: 'implement', visit: 1, phase: 'green', ordinal: 3, run: 'r1', attempt: 1 };
const asText = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));

test('commit messages carry the stage and action trailers', () => {
  const m = marker.formatMarker(parts);
  for (const kind of ['test', 'feat', 'fix']) {
    const message = render.commitMessage({
      kind, title: 'Add the cart total', ticket: 7, summary: 'Sums line items.',
      vertex: 'implement', harness: 'claude', model: 'opus', effort: 'high', marker: m,
    });
    const lines = message.trimEnd().split('\n');
    assert.equal(lines[0], `${kind}: Add the cart total (#7)`);
    assert.ok(message.includes('Sums line items.'));
    assert.deepEqual(lines.slice(-2), ['Feature-Flow-Stage: implement claude/opus/high', `Gg-Action: ${m}`]);
    assert.deepEqual(asText(marker.parseMarker(message)), asText(parts));
  }
});

const impl = {
  summary: 'Adds the cart total.',
  dod: [{ item: 'Total sums items', met: true, evidence: 'test/cart.test.mjs' }, { item: 'Docs', met: false, evidence: '' }],
  red: { command: 'npm test', output: 'not ok 1 - total' },
  green: { command: 'npm test', output: 'ok 1 - total' },
  qa: { setup: 'npm ci', steps: [{ action: 'Run gg', expected: 'Total shown' }], edgeCases: ['empty cart'], automated: ['total'], manual: [] },
};
const provenance = [
  { vertex: 'implement', harness: 'claude', model: 'opus', effort: 'high', persona: 'tdd-implementer', hash: 'abc123', calls: 2, input: 100, cached: 40, output: 20 },
  { vertex: 'review', harness: 'codex', model: 'gpt', effort: 'medium', persona: 'reviewer', hash: 'def456', calls: 1, input: 50, cached: 0, output: 10 },
];

test('the PR body carries the marker line and provenance', () => {
  const m = marker.formatMarker(parts);
  const body = render.prBody({ ticket: { number: 7 }, impl, provenance, marker: m });
  assert.ok(body.startsWith('Closes #7'));
  assert.equal(body.trimEnd().split('\n').at(-1), `<!-- gg-action ${m} -->`);
  assert.deepEqual(asText(marker.parseMarker(body)), asText(parts));
  const row = body.split('\n').find((l) => l.startsWith('| implement |'));
  assert.ok(row, 'provenance row for the implement vertex');
  assert.match(row, /tdd-implementer@abc123/);
  assert.match(body, /- \[x\] Total sums items/);
  assert.match(body, /- \[ \] Docs/);
});

test('comments are fenced and carry the marker line', () => {
  const m = marker.formatMarker(parts);
  const last = (s) => s.trimEnd().split('\n').at(-1);
  const fenced = (s) => '```\n' + s + '\n```';

  const blocked = render.blockedComment({ claim: 'blocked', summary: 'Cannot reach the API.', notes: 'The ticket needs a token.', diagnosis: '' }, m);
  assert.ok(blocked.includes(fenced('The ticket needs a token.')), 'blocked notes are fenced');
  assert.equal(last(blocked), `<!-- gg-action ${m} -->`);

  const diagnosis = render.diagnosisComment({ claim: 'misscoped', summary: 'Too big.', notes: '', diagnosis: 'Split into two tickets.' }, m);
  assert.ok(diagnosis.includes(fenced('Split into two tickets.')), 'diagnosis is fenced');
  assert.equal(last(diagnosis), `<!-- gg-action ${m} -->`);

  const review = render.reviewComment(
    {
      claim: 'changes', summary: 'One bug.', dodMet: true, tddEvidenceOk: true, diagnosis: '',
      findings: [{ severity: 'major', file: 'lib/a.mjs', issue: 'off by one\n```\n## Injected heading', fix: 'use <=\n# Another' }],
    },
    provenance[1], m,
  );
  assert.match(review, /reviewer@def456/);
  assert.match(review, /\*\*changes\*\*/);
  assert.match(review, /VERDICT: changes/);
  assert.doesNotMatch(review, /undefined/);
  assert.ok(review.includes('````\noff by one\n```\n## Injected heading\n````'), 'finding issue is fenced past its own backticks');
  assert.ok(review.includes(fenced('use <=\n# Another')), 'finding fix is fenced');
  assert.equal(last(review), `<!-- gg-action ${m} -->`);
});
