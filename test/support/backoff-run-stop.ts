// A run stop that lands while a golden Execution backs off: another Ticket's harness call fails with class auth.
import type * as effects from '../../lib/effects.ts';
import * as interpreter from '../../lib/interpreter.ts';
import type * as record from '../../lib/record.ts';
import * as executionReads from './execution-reads.ts';
import type * as golden from './golden.ts';

// Runs the Execution, from `executionRecord` when given, and stops the run as Ticket #21's auth failure at its first
// sleep. Returns the result, the shared run state, and, given `retryKey`, that retry as saved when the sleep began.
export async function runStoppedInBackoff(
  fixture: golden.GoldenFixture,
  { retryKey, executionRecord }: { retryKey?: string; executionRecord?: record.ExecutionRecord },
) {
  const runState: effects.RunState = { stop: null, remoteNotBefore: 0 };
  let saved: effects.RemoteRetry | undefined;
  const stop = () => {
    runState.stop = { failureClass: 'auth', ticket: 21 };
  };
  fixture.clock.onSleep = retryKey
    ? async () => {
        saved = (await executionReads.loadTicket(fixture)).retries[retryKey]!.remote;
        stop();
      }
    : stop;
  const result = await interpreter.runExecution({
    ...fixture.options,
    record: executionRecord ?? fixture.options.record,
    runState,
  });
  return { result, runState, saved };
}
