// A case's step after each call the golden fixture's fake harness answers, as an agent acting past its scripted files.
import type * as fakeHarness from './fake-harness.ts';

// Each call runs on the fake harness as before; `after` then sees the call, and the harness's result is returned.
export function afterEachCall(
  fixture: { harness: fakeHarness.FakeHarness },
  after: (call: fakeHarness.HarnessCall) => void,
): void {
  const run = fixture.harness.run;
  fixture.harness.run = async (call) => {
    const result = await run(call);
    after(call as fakeHarness.HarnessCall);
    return result;
  };
}
