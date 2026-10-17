import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULTS_DIR = fileURLToPath(new URL('../defaults/', import.meta.url));
export const PERSONAS_DIR = join(DEFAULTS_DIR, 'personas');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// The shipped Layer: defaults/gg.json plus the bytes and hash of every Persona its Nodes name.
export function loadDefaults() {
  const config = JSON.parse(readFileSync(join(DEFAULTS_DIR, 'gg.json'), 'utf8'));
  const personas = {};
  for (const { persona } of Object.values(config.nodes)) {
    const bytes = readFileSync(join(PERSONAS_DIR, persona), 'utf8');
    personas[persona] = { bytes, hash: sha256(bytes) };
  }
  return { ...config, personas };
}

// Sorted keys at every depth, so the hash ignores key order.
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]))
    : value;

export function configHash({ flow, personas, harnesses, launchProfile = null, commands }) {
  return sha256(JSON.stringify(canonical({ flow, personas, harnesses, launchProfile, commands })));
}

// Commands are declared in the repo's AGENTS.md as "- test: `cmd`" lines under "## Commands".
export function parseCommands(agentsMd, warn = console.warn) {
  const section = agentsMd.split(/^## /m).find((s) => /^Commands\b/.test(s)) ?? '';
  const cmds = {};
  // `gg init` writes TODO placeholders; they must not become allowlisted commands.
  for (const m of section.matchAll(/^[-*]\s*([\w-]+)\s*:\s*`([^`]+)`/gm)) {
    if (m[2].trim() === 'TODO') continue;
    const name = m[1].toLowerCase();
    if (name in cmds) warn(`AGENTS.md ## Commands defines "${name}" more than once; the last one wins`);
    cmds[name] = m[2];
  }
  return cmds;
}

export function loadCommands(repoRoot) {
  const p = join(repoRoot, 'AGENTS.md');
  return existsSync(p) ? parseCommands(readFileSync(p, 'utf8')) : {};
}
