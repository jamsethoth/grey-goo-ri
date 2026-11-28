import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as exampleSource from '../support/example-source.ts';

// A push or pr-upsert that finds no commit its base lacks ends the Visit with the engine Outcome nothing-to-publish
// (#490, Q1 A, Q2 A).
const PUBLISHING_KINDS = ['push', 'pr-upsert'];

test('every Vertex whose Procedure has a push or pr-upsert Action can end nothing-to-publish, and no other', () => {
  const config = exampleSource.config();
  const { errors, flows } = exampleSource.check(config);
  assert.deepEqual(errors, []);
  const publishes = new Map(
    Object.entries(config.procedures).map(([name, procedure]) => [
      name,
      procedure.actions.some((action) => PUBLISHING_KINDS.includes(action.do)),
    ]),
  );
  const vertices = Object.entries(flows.default.ticket.vertices);
  assert.deepEqual(
    Object.fromEntries(vertices.map(([name, vertex]) => [name, vertex.outcomes.includes('nothing-to-publish')])),
    Object.fromEntries(vertices.map(([name, vertex]) => [name, publishes.get(vertex.procedure)])),
  );
});

test('a Vertex may route nothing-to-publish like any engine Outcome, and unrouted it ends at needs-human', () => {
  const routed = exampleSource.config();
  exampleSource.putAt(routed.flows.default.ticket.vertices.green.route, ['nothing-to-publish'], {
    end: 'needs-replan',
  });
  exampleSource.putAt(routed.flows.default.ticket.vertices.publish.route, ['nothing-to-publish'], {
    end: 'needs-replan',
  });
  const { errors, flows } = exampleSource.check(routed);
  assert.deepEqual(errors, []);
  assert.deepEqual(flows.default.ticket.vertices.green.routing['nothing-to-publish'], {
    target: { end: 'needs-replan' },
    by: 'Vertex route',
    work: 'left in place',
  });
  assert.deepEqual(flows.default.ticket.vertices.publish.routing['nothing-to-publish'], {
    target: { end: 'needs-replan' },
    by: 'Vertex route',
    work: null,
  });
  const unrouted = exampleSource.config();
  exampleSource.putAt(unrouted.flows.default.ticket.routes, ['*']);
  exampleSource.putAt(unrouted.flows.default.ticket.routes, ['nothing-to-publish']);
  exampleSource.putAt(unrouted.flows.default.ticket.routes, ['blocked'], { end: 'needs-human' });
  const engine = exampleSource.check(unrouted);
  assert.deepEqual(engine.errors, []);
  assert.deepEqual(engine.flows.default.ticket.vertices.reviewer.routing['nothing-to-publish'], {
    target: { end: 'needs-human' },
    by: 'engine default',
    work: null,
  });
});

// DoD 3: the example names the Outcome in its own Flow routes, not only under "*", so its route reads as chosen.
test('the example Flow routes nothing-to-publish to end: needs-human by its Flow routes at every Vertex', () => {
  const { errors, flows } = exampleSource.check(exampleSource.config());
  assert.deepEqual(errors, []);
  const routed = Object.entries(flows.default.ticket.vertices)
    .filter(([, vertex]) => vertex.outcomes.includes('nothing-to-publish'))
    .map(([name, vertex]) => {
      const { target, by } = vertex.routing['nothing-to-publish']!;
      return { name, target, by };
    });
  assert.deepEqual(
    routed.map(({ name }) => name),
    ['green', 'senior-green', 'reviewer', 'implementer-fix', 'senior-dev', 'publish'],
  );
  for (const { name, target, by } of routed)
    assert.deepEqual({ target, by }, { target: { end: 'needs-human' }, by: 'Flow routes' }, name);
});
