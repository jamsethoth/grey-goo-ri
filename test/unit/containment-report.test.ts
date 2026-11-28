import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as containmentReport from '../../lib/containment-report.ts';

const JOB = { kind: 'job' } as const;

test("an escapee's none report comes after the containment's, which is reported once", () => {
  const kinds: string[] = [];
  const reports = containmentReport.startedReports(
    ({ kind }) => void kinds.push(kind),
    JOB,
    () => {},
  );
  reports.started();
  reports.escapee();
  reports.started();
  assert.deepEqual(kinds, ['job', 'none']);
});

test('a none report that throws throws on, then takes the call down', async () => {
  const saveFailed = new Error('the none save failed');
  const order: string[] = [];
  const onStarted = ({ kind }: { kind: string }) => {
    if (kind === 'none') throw saveFailed;
  };
  const reports = containmentReport.startedReports(onStarted, JOB, () => order.push('taken down'));
  assert.throws(() => reports.escapee(), saveFailed);
  order.push('thrown');
  await Promise.resolve();
  assert.deepEqual(order, ['thrown', 'taken down']);
});
