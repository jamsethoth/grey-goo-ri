// A Claude configuration directory where plugins are installed as Claude Code lists them, each declaring its hooks in
// either place Claude reads them (#484 Q5 A): its hooks/hooks.json, and its plugin.json's `hooks` field, a path to a
// hooks file, an inline map of events, or a list of either.
import type { TestContext } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as tempDirectory from './temp-directory.ts';

// One matcher group of an event: its tool filter (left out when undefined) and the command it runs.
export interface HookGroup {
  matcher?: string;
  hooks: { type: 'command'; command: string }[];
}
// A hooks map, event by event, as hooks/hooks.json holds it under `hooks`.
export type HookEvents = Record<string, HookGroup[]>;

// What plugin.json's `hooks` may hold: a path from the plugin's root to a hooks file, or an inline map, or a list.
export type ManifestHooks = string | HookEvents | (string | HookEvents)[];

// A plugin's hooks: hooks/hooks.json's map, plugin.json's `hooks` field, and the hooks files that field's paths name,
// by path from the plugin's root, each written as hooks/hooks.json is, its map under `hooks`.
export interface HookedPlugin {
  hooksJson?: HookEvents;
  manifestHooks?: ManifestHooks;
  hookFiles?: Record<string, HookEvents>;
}

// One group on `event` whose tool filter is `matcher`, running one command.
export const hookOn = (event: string, matcher?: string): HookEvents => ({
  [event]: [{ ...(matcher !== undefined && { matcher }), hooks: [{ type: 'command', command: 'node hook.js' }] }],
});

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

// The configuration directory, removed when the case ends, with each plugin installed under its key (`name@market`).
export function claudePluginHome(t: TestContext, plugins: Record<string, HookedPlugin>): string {
  const configDirectory = tempDirectory.tempDirectory(t, 'gg-claude-plugins-');
  const installed: Record<string, { installPath: string }[]> = {};
  for (const [key, { hooksJson, manifestHooks, hookFiles = {} }] of Object.entries(plugins)) {
    const [name] = key.split('@');
    const installPath = join(configDirectory, 'cache', name!);
    installed[key] = [{ installPath }];
    writeJson(join(installPath, '.claude-plugin', 'plugin.json'), {
      name,
      version: '1.0.0',
      ...(manifestHooks !== undefined && { hooks: manifestHooks }),
    });
    if (hooksJson) writeJson(join(installPath, 'hooks', 'hooks.json'), { hooks: hooksJson });
    for (const [path, events] of Object.entries(hookFiles)) writeJson(join(installPath, path), { hooks: events });
  }
  writeJson(join(configDirectory, 'plugins', 'installed_plugins.json'), { plugins: installed });
  return configDirectory;
}
