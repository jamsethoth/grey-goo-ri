import type * as exec from '../exec.ts';
import * as claude from './claude.ts';
import * as codex from './codex.ts';
import * as contract from './contract.ts';

// Every Harness gg ships, by the name an Agent selects, as each declares itself: what gg reads without starting a
// process, such as its Protected Files. A new Harness is one module and one entry here.
export const HARNESSES = { claude, codex };

// Each shipped Harness: the contract's members of its declaration joined with the members it builds from exec to start
// its CLI (Q1 A). A module's other exports, such as its builders and test seams, stay its own. bin/gg.ts calls it once
// with the exec it passes down (ADR 0019).
export function shipped(runner: Pick<exec.Exec, 'launch' | 'childInJob'>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(HARNESSES).map(([name, { createCli, ...declaration }]) => [
      name,
      {
        ...Object.fromEntries(
          Object.entries(declaration).filter(([member]) => contract.HARNESS_METHODS.includes(member)),
        ),
        ...createCli(runner),
      },
    ]),
  );
}
