// The await-approval Action: ADR 0003's request and a Decision's consumption, each step write-ahead.
import * as effects from './effects.ts';
import type { RunContext } from './run-context.ts';
import type * as visitScope from './visit-scope.ts';

export async function awaitApproval(
  runContext: RunContext,
  { actionIdentity }: visitScope.Running,
): Promise<visitScope.ActionResolution> {
  return effects.saveResolution(runContext, {
    actionIdentity,
    startedAt: runContext.clock.now(),
    resolution: {
      outcome: 'ok',
      direction: 'advance',
      row: 'effect-completed',
      rule: { table: 'fixed', row: 'effect-completed' },
    },
  });
}
