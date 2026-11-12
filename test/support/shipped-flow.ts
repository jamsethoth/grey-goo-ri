// The configuration gg shipped in defaults/ until #121: its Agents, Procedures, Flow and their files, kept under
// test/fixtures/shipped-flow/ as the golden traces' source.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as config from '../../lib/config.ts';

const DIRECTORY = fileURLToPath(new URL('../fixtures/shipped-flow/', import.meta.url));

// The source as gg read it: gg.json, with every other file of the fixture by its path from there.
export function shippedLayer(): config.Source {
  const layer = JSON.parse(readFileSync(join(DIRECTORY, 'gg.json'), 'utf8')) as Omit<config.Source, 'files'>;
  const files = readdirSync(DIRECTORY, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== 'gg.json')
    .map((entry) => {
      const bytes = readFileSync(join(entry.parentPath, entry.name), 'utf8');
      const name = relative(DIRECTORY, join(entry.parentPath, entry.name)).replaceAll('\\', '/');
      return [name, { bytes, hash: config.sha256(bytes) }];
    });
  return { ...layer, files: Object.fromEntries(files) };
}
