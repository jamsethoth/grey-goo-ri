// caseEnv, the helper that sets environment variables until a case ends (#430 D8 A).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as caseEnv from '../support/case-env.ts';

const VARIABLE = 'GG_CASE_ENV_TEST';
const before = process.env[VARIABLE];
// A variable that has a value before the case, which the restore must write back rather than delete (#464).
const SET = 'GG_CASE_ENV_TEST_SET';
process.env[SET] = 'before';

test('a case that sets one variable twice sees the second value', (t) => {
  caseEnv.caseEnv(t, { [VARIABLE]: 'one', [SET]: 'one' });
  caseEnv.caseEnv(t, { [VARIABLE]: 'two', [SET]: 'two' });
  assert.equal(process.env[VARIABLE], 'two');
  assert.equal(process.env[SET], 'two');
});

test('each variable a case set twice is back to its value before the case', () => {
  assert.equal(process.env[VARIABLE], before);
  assert.equal(process.env[SET], 'before');
});
