// The check_results table: each `reuse: tree` command Check's result in this repository, keyed on the tree it checked
// and its resolved command line (L8, L13). Failing results are recorded too, but only a pass is ever reused.
import type { DatabaseSync } from 'node:sqlite';

// A `reuse: tree` command Check's result: the tree it checked, its resolved command line, its state, the Action Marker
// of the Attempt that ran it, and its output.
export interface CheckResult {
  tree: string;
  command: string;
  state: string;
  marker: string;
  output: string;
}

export function save(connection: DatabaseSync, { tree, command, state, marker, output }: CheckResult): void {
  connection
    .prepare('INSERT INTO check_results (ts, tree, command, state, marker, output) VALUES (?, ?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), tree, command, state, marker, output);
}

export const reusablePass = (
  connection: DatabaseSync,
  tree: string,
  command: string,
): Pick<CheckResult, 'marker' | 'output'> | null =>
  (connection
    .prepare(
      'SELECT marker, output FROM check_results WHERE tree = ? AND command = ? ' +
        "AND state = 'passed' ORDER BY id DESC LIMIT 1",
    )
    .get(tree, command) as Pick<CheckResult, 'marker' | 'output'> | undefined) ?? null;
