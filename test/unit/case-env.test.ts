// caseEnv, the helper that sets environment variables until a case ends (#430 D8 A).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as caseEnv from '../support/case-env.ts';

const VARIABLE = 'GG_CASE_ENV_TEST';
const before = process.env[VARIABLE];

test('a case that sets one variable twice sees the second value', (t) => {
  caseEnv.caseEnv(t, { [VARIABLE]: 'one' });
  caseEnv.caseEnv(t, { [VARIABLE]: 'two' });
  assert.equal(process.env[VARIABLE], 'two');
});

test('the variable a case set twice is back to its value before the case', () => {
  assert.equal(process.env[VARIABLE], before);
});
