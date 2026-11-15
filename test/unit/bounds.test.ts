import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as bounds from '../../lib/bounds.ts';
import { countedExecution } from '../support/counted-execution.ts';

test("when an Edge and its Vertex exhaust together the Vertex's exhausted target wins", () => {
  const execution = countedExecution({
    route: { changes: { to: 'implementer-fix', max: 1, exhausted: { end: 'needs-human' } } },
    vertices: { 'implementer-fix': { max: 1, exhausted: 'senior-dev' }, 'senior-dev': { max: 1 } },
    visits: { 'implementer-fix': 1 },
    traversals: { 'reviewer->implementer-fix:changes': 1 },
  });

  assert.equal(bounds.edge(execution, 'changes').next, 'senior-dev');
});

test('a route passes through a chain of spent Vertices to the last exhausted target', () => {
  const execution = countedExecution({
    route: { changes: { to: 'implementer-fix', max: 2, exhausted: { end: 'needs-human' } } },
    vertices: {
      'implementer-fix': { max: 1, exhausted: 'senior-dev' },
      'senior-dev': { max: 1, exhausted: { end: 'needs-replan' } },
    },
    visits: { 'implementer-fix': 1, 'senior-dev': 1 },
    traversals: { 'reviewer->implementer-fix:changes': 1 },
  });

  const traversal = bounds.traverse(execution, 'changes');

  assert.equal(traversal.next, 'needs-replan');
  assert.equal(
    bounds.spentText(traversal),
    ', and implementer-fix had used its Bound of 1 Visit and senior-dev had used its Bound of 1 Visit, ' +
      'so the route ended at needs-replan',
  );
});

test('a route into a loop of spent Vertices ends at needs-human', () => {
  const execution = countedExecution({
    route: { ok: 'first-fix' },
    vertices: { 'first-fix': { max: 1, exhausted: 'second-fix' }, 'second-fix': { max: 1, exhausted: 'first-fix' } },
    visits: { 'first-fix': 1, 'second-fix': 1 },
  });

  assert.equal(bounds.edge(execution, 'ok').next, 'needs-human');
  assert.equal(bounds.routesToVertex(execution, 'ok'), false);
});

test('a Flow Attempt at the Action Cap still runs', () => {
  assert.equal(bounds.capped(countedExecution({ attempts: 4, actionCap: 4 })), null);
});

test('a Flow Attempt one past the Action Cap ends the Execution at needs-human', () => {
  assert.deepEqual(bounds.capped(countedExecution({ attempts: 5, actionCap: 4 })), {
    outcome: 'needs-human',
    direction: 'stop',
    row: 'action-cap',
    rule: { table: 'fixed', row: 'action-cap' },
    actionCap: 4,
  });
});
