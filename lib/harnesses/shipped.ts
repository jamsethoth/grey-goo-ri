import type * as exec from '../exec.ts';
import * as claude from './claude.ts';
import * as codex from './codex.ts';

// Every Harness gg ships, by the name an Agent selects, as each declares itself: what gg reads without starting a
// process, such as its Protected Files. A new Harness is one module and one entry here.
export const HARNESSES = { claude, codex };

// Each shipped Harness: its declaration joined with the members it builds from exec to start its CLI (Q1 A), without
// the builder itself. bin/gg.ts calls it once with the exec it passes down (ADR 0019).
export function shipped(runner: Pick<exec.Exec, 'launch'>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(HARNESSES).map(([name, { createCli, ...declaration }]) => [
      name,
      { ...declaration, ...createCli(runner) },
    ]),
  );
}
