// The configs table: each Pinned Configuration, by its Config Hash, kept from the first Run that pinned it.
import type { DatabaseSync } from 'node:sqlite';
import * as jsonValue from '../json-value.ts';

export function save<Pinned>(
  connection: DatabaseSync,
  hash: string,
  pinned: Pinned & NoInfer<jsonValue.JsonChecked<Pinned>>,
): void {
  connection
    .prepare('INSERT OR IGNORE INTO configs (hash, json, firstSeen) VALUES (?, ?, ?)')
    .run(hash, jsonValue.text<Pinned>(pinned, 'the Pinned Configuration'), new Date().toISOString());
}

export function load(connection: DatabaseSync, hash: string): unknown {
  const row = connection.prepare('SELECT json FROM configs WHERE hash = ?').get(hash);
  return row ? JSON.parse(row.json as string) : null;
}
