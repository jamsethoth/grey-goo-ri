import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as marker from '../../lib/marker.ts';
import * as actionMarkerParts from '../support/action-marker-parts.ts';

const { parts, asText } = actionMarkerParts;

test('a marker carries the action id and recovery number', () => {
  const actionMarker = marker.formatMarker({
    execution: '142.4f9e21',
    vertex: 'needs-human',
    visit: 1,
    action: 'hold-comment',
    recovery: 0,
    run: 'r1',
    attempt: 1,
  });
  assert.equal(actionMarker, 'gg:142.4f9e21:needs-human:1:hold-comment:0:r1:1');
  assert.deepEqual(marker.parseMarker(marker.markerComment(actionMarker)), {
    execution: '142.4f9e21',
    vertex: 'needs-human',
    visit: '1',
    action: 'hold-comment',
    recovery: '0',
    run: 'r1',
    attempt: '1',
  });
  assert.deepEqual(asText(marker.partsOf(marker.formatMarker(parts))), asText(parts));
  assert.equal(
    marker.actionKeyOf(parts),
    'implement/2/test/1',
    'the retry key is the Action identity without the Attempt',
  );
});

test('marker round-trips through the commit trailer', () => {
  const actionMarker = marker.formatMarker(parts);
  assert.equal(actionMarker, 'gg:e1:implement:2:test:1:r1:1');
  assert.equal(marker.markerTrailer(actionMarker), `Gg-Action: ${actionMarker}`);
  const message =
    `Add the cart total\n\nBody text.\n\nRefs: #7\n${marker.markerTrailer(actionMarker)}\n` +
    'Co-Authored-By: Someone <a@b.c>\n';
  assert.deepEqual(asText(marker.parseMarker(message)), asText(parts));
});

test('marker round-trips through the PR body comment line', () => {
  const actionMarker = marker.formatMarker(parts);
  assert.equal(marker.markerComment(actionMarker), `<!-- gg-action ${actionMarker} -->`);
  const body = `## Summary\n\nCloses #7\n\n${marker.markerComment(actionMarker)}\n`;
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
