// The bare origin.git and its clone main that every real-git test repo starts from, built once per test process:
// building them costs a test seven git processes. Auto maintenance and gc are off, so no git call spawns another.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as gitShell from './git-shell.ts';

const sh = gitShell.sh;

export const TEMPLATE_PACKAGE = '{ "scripts": { "test": "node --test" } }\n';

interface Template {
  root: string;
  url: string;
  base: string;
}

function buildTemplate(): Template {
  const root = mkdtempSync(join(tmpdir(), 'gg-template-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  sh(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  const origin = join(root, 'origin.git');
  sh(origin, 'config', 'maintenance.auto', 'false');
  sh(origin, 'config', 'gc.auto', '0');
  sh(root, 'clone', '-q', 'origin.git', 'main');
  const mainRoot = join(root, 'main');
  sh(mainRoot, 'config', 'maintenance.auto', 'false');
  sh(mainRoot, 'config', 'gc.auto', '0');
  sh(mainRoot, 'config', 'user.name', 't');
  sh(mainRoot, 'config', 'user.email', 't@t');
  writeFileSync(join(mainRoot, 'package.json'), TEMPLATE_PACKAGE);
  sh(mainRoot, 'add', '-A');
  sh(mainRoot, 'commit', '-q', '-m', 'init');
  sh(mainRoot, 'push', '-q', 'origin', 'main');
  return { root, url: sh(mainRoot, 'config', 'remote.origin.url'), base: sh(mainRoot, 'rev-parse', 'main') };
}

// The template is the test process's, built on first use and never swapped.
const templates: Template[] = [];
const template = () => templates[0] ?? (templates[0] = buildTemplate());

// Copies the template's origin.git and main into `directory`, a fresh mkdtemp directory, commits `files` to main when
// given, and returns main's SHA. git records a clone's origin by its real path with forward slashes, so `directory` is
// the real one, never a link to it.
export function seedRepos(directory: string, files: Record<string, string> = {}): string {
  const { root, url: templateUrl, base } = template();
  cpSync(root, directory, { recursive: true });
  const config = join(directory, 'main', '.git', 'config');
  const text = readFileSync(config, 'utf8');
  const url = `${templateUrl.slice(0, -`${basename(root)}/origin.git`.length)}${basename(directory)}/origin.git`;
  if (dirname(directory) !== dirname(root) || text.split(templateUrl).length !== 2)
    throw new Error(`cannot point ${config} at ${url}`);
  writeFileSync(config, text.replace(templateUrl, url));
  if (!Object.keys(files).length) return base;
  const mainRoot = join(directory, 'main');
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(mainRoot, path)), { recursive: true });
    writeFileSync(join(mainRoot, path), bytes);
  }
  sh(mainRoot, 'add', '-A');
  sh(mainRoot, 'commit', '-q', '-m', 'files');
  return sh(mainRoot, 'rev-parse', 'main');
}
