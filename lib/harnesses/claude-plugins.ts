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

// Whether Claude fires a hook whose tool filter is `matcher` on `tool`: left out, empty or `*` is every tool; letters,
// digits, `_`, `-`, spaces, `|` and `,` alone are a list of exact names; anything else is an unanchored regular
// expression, which Claude cannot compile when it is invalid, so it fires on nothing.
function matches(matcher: unknown, tool: string): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (typeof matcher !== 'string') return false;
  if (/^[\w ,|-]+$/.test(matcher)) return matcher.split(/[|,]/).some((name) => name.trim() === tool);
  try {
    return new RegExp(matcher).test(tool);
  } catch {
    return false;
  }
}

// The hook maps a plugin declares, which Claude merges: hooks/hooks.json's, and plugin.json's `hooks`, a path from the
// plugin's root to a file like hooks/hooks.json, an inline map, or a list of either.
function hookMaps(directory: string): unknown[] {
  const declared = readObject(join(directory, '.claude-plugin', 'plugin.json'))?.hooks;
  return [
    readObject(join(directory, 'hooks', 'hooks.json'))?.hooks,
    ...[declared ?? []]
      .flat()
      .map((entry: unknown) => (typeof entry === 'string' ? readObject(join(directory, entry))?.hooks : entry)),
  ];
}

// Only these events run before a tool and can change its input (#484 Q5 A); the others act after it ran.
const REWRITING_EVENTS = ['PreToolUse', 'PermissionRequest'];

// Whether the plugin in `directory` declares a hook that can rewrite `tool`'s input before it runs (#484 Q5 A). gg
// judges by what the plugin declares, not by what its hook's command does.
export const rewrites = (directory: string, tool: string): boolean =>
  hookMaps(directory).some(
    (map) =>
      referencePaths.isRecord(map) &&
      REWRITING_EVENTS.some((event) =>
        [map[event] ?? []]
          .flat()
          .some((group: unknown) => referencePaths.isRecord(group) && matches(group.matcher, tool)),
      ),
  );
