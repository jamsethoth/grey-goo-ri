// Where a listed plugin is installed, read from Claude Code's configuration directory, for lib/harnesses/claude.ts
// alone.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as referencePaths from '../reference-paths.ts';

// A JSON file's object, or undefined when it is missing, unreadable or not an object.
function readObject(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return referencePaths.isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const directories = (parent: string) =>
  readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));

// A listed plugin's directory, which a missing plugin fails before any spawn (ported, feature-flow 89e1d67
// lib/toolkit.mjs:23-40): installed (marketplace) plugins first, then account-synced ones under
// plugins/synced/<id>/[<id>/]<name>. `alpha@mkt` matches that installed key exactly; a bare `alpha` matches
// `alpha@<any>` and must be unique.
export function pluginDirectory(plugin: string, configDirectory: string): string {
  const installed = readObject(join(configDirectory, 'plugins', 'installed_plugins.json'))?.plugins;
  const keys = Object.keys(referencePaths.isRecord(installed) ? installed : {}).filter((key) =>
    plugin.includes('@') ? key === plugin : key.split('@')[0] === plugin,
  );
  if (keys.length > 1) throw new Error(`plugin ${plugin} ambiguous: ${keys.join(', ')}`);
  const entry: unknown =
    keys[0] === undefined ? undefined : [(installed as Record<string, unknown>)[keys[0]]].flat()[0];
  const path = referencePaths.isRecord(entry) ? entry.installPath : undefined;
  if (typeof path === 'string' && existsSync(path)) return path;
  const synced = join(configDirectory, 'plugins', 'synced');
  if (existsSync(synced))
    for (const top of directories(synced))
      for (const candidate of [...directories(top), ...directories(top).flatMap(directories)])
        if (readObject(join(candidate, '.claude-plugin', 'plugin.json'))?.name === plugin) return candidate;
  throw new Error(`plugin ${plugin} is not installed`);
}
