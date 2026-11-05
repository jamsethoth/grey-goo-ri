// A fake Harness whose `phase` calls are followed by `then`, as an agent's write beyond its scripted files would be.
import type * as fakeHarness from './fake-harness.ts';

export function afterPhase(
  fixture: { harness: Pick<fakeHarness.FakeHarness, 'run'> },
  phase: string,
  then: () => void,
): void {
  const run = fixture.harness.run;
  fixture.harness.run = async (call) => {
    const result = await run(call);
    if (call.phase === phase) then();
    return result;
  };
}
