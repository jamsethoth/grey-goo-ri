// What a listed plugin brings, for lib/harnesses/codex.ts alone: its parts, found by manifest key or folder file from
// a layout the Harness passes in, and those outside the set it admits (#481 Q3 C, with the folder check). The check
// names no Harness, so it moves unchanged into a shared module once a second Harness calls it (#535).

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

// stub (#481): finds nothing.
export function acceptance(_directory: string, _layout: PluginLayout, _admitted: string[]): Acceptance {
  return { parts: [], refused: [] };
}
