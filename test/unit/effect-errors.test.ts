import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as effectErrors from '../../lib/effect-errors.ts';
import * as record from '../../lib/record.ts';

test('a crash or a failed save is fatal, and any other error is not', () => {
  assert.equal(effectErrors.fatal(new effectErrors.CrashError('crash')), true);
  assert.equal(effectErrors.fatal(new record.RecordSaveError(new Error('disk full'))), true);
  assert.equal(effectErrors.fatal(new Error('gh failed')), false);
});

test('a crash point throws a CrashError only at its own point of its own marker', () => {
  const context = { crashAt: { marker: 'gg:m', point: 'after-effect' as const } };
  assert.throws(() => effectErrors.crashPoint(context, 'gg:m', 'after-effect'), effectErrors.CrashError);
  assert.equal(effectErrors.crashPoint(context, 'gg:m', 'before-effect'), undefined);
  assert.equal(effectErrors.crashPoint(context, 'gg:other', 'after-effect'), undefined);
  assert.equal(effectErrors.crashPoint({}, 'gg:m', 'after-effect'), undefined);
});

test('an early Terminal carries its ending, and its reason as its message', () => {
  const ending = { next: 'hold' as const, name: 'unchecked-publish', reason: 'PR #7 was not marked ready.' };
  const early = new effectErrors.EarlyTerminalError(ending);
  assert.equal(early.ending, ending);
  assert.equal(early.message, 'PR #7 was not marked ready.');
});

test('a spent retry budget keeps the last failure as its cause and its message', () => {
  const last = new Error('gh: Bad Gateway (HTTP 502)');
  const spent = { failureClass: 'transient' as const, status: 502, count: 2, effect: 'comment' };
  const exhausted = new effectErrors.RetriesExhaustedError(last.message, spent, { cause: last });
  assert.equal(exhausted.message, 'gh: Bad Gateway (HTTP 502)');
  assert.equal(exhausted.cause, last);
  assert.deepEqual(exhausted.spent, spent);
});
