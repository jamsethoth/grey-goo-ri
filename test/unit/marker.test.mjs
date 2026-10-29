import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as marker from '../../lib/marker.mjs';

const parts = { execution: 'e1', vertex: 'implement', visit: 2, action: 'test', recovery: 1, run: 'r1', attempt: 1 };
// Parsed parts come back as strings; compare on that form.
const asText = (p) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, String(v)]));

test('a marker carries the action id and recovery number', () => {
  const m = marker.formatMarker({ execution: '142.4f9e21', vertex: 'needs-human', visit: 1, action: 'hold-comment', recovery: 0, run: 'r1', attempt: 1 });
  assert.equal(m, 'gg:142.4f9e21:needs-human:1:hold-comment:0:r1:1');
  assert.deepEqual(marker.parseMarker(marker.markerComment(m)),
    { execution: '142.4f9e21', vertex: 'needs-human', visit: '1', action: 'hold-comment', recovery: '0', run: 'r1', attempt: '1' });
  assert.deepEqual(asText(marker.partsOf(marker.formatMarker(parts))), asText(parts));
  assert.equal(marker.actionKeyOf(parts), 'implement/2/test/1', 'the retry key is the Action identity without the Attempt');
});

test('marker round-trips through the commit trailer', () => {
  const m = marker.formatMarker(parts);
  assert.equal(m, 'gg:e1:implement:2:test:1:r1:1');
  assert.equal(marker.markerTrailer(m), `Gg-Action: ${m}`);
  const message = `Add the cart total\n\nBody text.\n\nRefs: #7\n${marker.markerTrailer(m)}\nCo-Authored-By: Someone <a@b.c>\n`;
  assert.deepEqual(asText(marker.parseMarker(message)), asText(parts));
});

test('marker round-trips through the PR body comment line', () => {
  const m = marker.formatMarker(parts);
  assert.equal(marker.markerComment(m), `<!-- gg-action ${m} -->`);
  const body = `## Summary\n\nCloses #7\n\n${marker.markerComment(m)}\n`;
  assert.deepEqual(asText(marker.parseMarker(body)), asText(parts));
});

test('parseMarker returns null without a marker', () => {
  assert.equal(marker.parseMarker('Add the cart total\n\nRefs: #7\nCo-Authored-By: Someone <a@b.c>\n'), null);
  assert.equal(marker.parseMarker(''), null);
});

test('formatMarker rejects a colon in the vertex id', () => {
  assert.throws(() => marker.formatMarker({ ...parts, vertex: 'impl:ement' }), /vertex/);
  assert.throws(() => marker.formatMarker({ ...parts, action: 'te:st' }), /action/);
});
