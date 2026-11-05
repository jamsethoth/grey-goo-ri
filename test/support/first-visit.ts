// The golden first Visit's scripted responses as a case starts from them.
import type * as fakeHarness from './fake-harness.ts';
import * as golden from './golden.ts';

// A copy of the first Visit's responses a case may change, with `responses` beside them or in place of their own.
export const firstVisitWith = (responses: fakeHarness.ScriptedResponses = {}): fakeHarness.ScriptedResponses => ({
  ...structuredClone(golden.firstVisitResponses),
  ...responses,
});
