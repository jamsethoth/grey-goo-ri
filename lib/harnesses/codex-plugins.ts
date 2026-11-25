// What a listed plugin brings, for lib/harnesses/codex.ts alone: its parts, found by manifest key or folder file from
// a layout the Harness passes in, and those outside the set it admits (#481 Q3 C, with the folder check). The check
// names no Harness, so it moves unchanged into a shared module once a second Harness calls it (#535).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as referencePaths from '../reference-paths.ts';

// Where a Harness's CLI finds a plugin's parts: the manifest's path inside the plugin's folder, each working part's
// manifest key and the folder files that bring it whatever the manifest says, and the manifest keys that bring none.
export interface PluginLayout {
  manifest: string;
  parts: Record<string, { key: string; files: string[] }>;
  descriptive: string[];
}

// The parts a plugin's folder brings, each by its name in the layout or, for a manifest key the layout does not
// know, by that key; and those of them outside the admitted set. A folder with no readable manifest brings
// `manifest`, which no set admits.
export interface Acceptance {
  parts: string[];
  refused: string[];
}

function readManifest(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return referencePaths.isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function acceptance(directory: string, layout: PluginLayout, admitted: string[]): Acceptance {
  const manifest = readManifest(join(directory, layout.manifest));
  if (manifest === undefined) return { parts: ['manifest'], refused: ['manifest'] };
  const partOfKey = new Map(Object.entries(layout.parts).map(([part, { key }]) => [key, part]));
  // A working key the layout does not know is a part by its own name, so an unrecorded kind fails closed (Q3).
  const parts = new Set(
    Object.keys(manifest)
      .filter((key) => !layout.descriptive.includes(key))
      .map((key) => partOfKey.get(key) ?? key),
  );
  for (const [part, { files }] of Object.entries(layout.parts))
    if (files.some((file) => existsSync(join(directory, file)))) parts.add(part);
  return { parts: [...parts], refused: [...parts].filter((part) => !admitted.includes(part)) };
}
