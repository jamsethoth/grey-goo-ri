// One Effect made and looked for over the golden fixture's fake git and fake gh, outside any Execution: the context its
// perform reads, its intent as the write-ahead log saves it, and its lookup as Reconciliation makes it.
import type { TestContext } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as effects from '../../lib/effects/index.ts';
import * as integrity from '../../lib/integrity.ts';
import type * as writeAhead from '../../lib/write-ahead.ts';
import * as golden from './golden.ts';

export async function effectFixture(t: TestContext) {
  const fixture = await golden.fixture(t);
  const { git, gh, database } = fixture.options.deps;
  const executionRecord = fixture.executionRecord;
  const worktree = fixture.worktree;
  const labelFailures: unknown[] = [];
  const context = {
    record: executionRecord,
    git,
    gh,
    cwd: fixture.mainRoot,
    log: (line: string) => fixture.logs.push(line),
    events: (_type: 'label_failed', fields: unknown) => labelFailures.push(fields),
    // The real Integrity Assertions over the fake git: a worktree proof reads the worktree as it is.
    integrity: integrity.createIntegrity(git),
    locks: undefined,
  };
  // An Action Marker at the green Vertex, for the Action named.
  const markerOf = (action: string) => golden.markerOf(executionRecord, 'green', 1, action);
  // An open intent of `effect`, as the write-ahead log saves it.
  const intent = (
    effect: { name: string },
    actionMarker: string,
    payload: writeAhead.Payload,
  ): writeAhead.WriteAheadEntry => ({
    step: 'intent',
    actionMarker,
    effect: effect.name,
    payload,
    evidence: null,
    time: '',
  });
  const lookedFor = (entry: writeAhead.WriteAheadEntry, issueLabels: string[] = []) =>
    effects.findEffect(entry, { executionRecord, git, gh, cwd: fixture.mainRoot, issueLabels });
  const proven = (entry: writeAhead.WriteAheadEntry) =>
    effects.proves(entry, worktree, { git, integrity: context.integrity });
  const write = (path: string, bytes: string) => {
    mkdirSync(dirname(join(worktree, path)), { recursive: true });
    writeFileSync(join(worktree, path), bytes);
  };
  return {
    fixture,
    executionRecord,
    worktree,
    git,
    gh,
    database: database!,
    context,
    labelFailures,
    markerOf,
    intent,
    lookedFor,
    proven,
    write,
  };
}
