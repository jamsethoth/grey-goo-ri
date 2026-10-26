// The bare origin.git and its clone main that every real-git test repo starts from, built once per test process:
// building them costs a test seven git processes. Auto maintenance and gc are off, so no git call spawns another.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

export const TEMPLATE_PACKAGE = '{ "scripts": { "test": "node --test" } }\n';

let template;
function buildTemplate() {
  const root = mkdtempSync(join(tmpdir(), 'gg-template-'));
  process.on('exit', () => rmSync(root, { recursive: true, force: true }));
  sh(root, 'init', '-q', '--bare', '-b', 'main', 'origin.git');
  const origin = join(root, 'origin.git');
  sh(origin, 'config', 'maintenance.auto', 'false'); sh(origin, 'config', 'gc.auto', '0');
  sh(root, 'clone', '-q', 'origin.git', 'main');
  const mainRoot = join(root, 'main');
  sh(mainRoot, 'config', 'maintenance.auto', 'false'); sh(mainRoot, 'config', 'gc.auto', '0');
  sh(mainRoot, 'config', 'user.name', 't'); sh(mainRoot, 'config', 'user.email', 't@t');
  writeFileSync(join(mainRoot, 'package.json'), TEMPLATE_PACKAGE);
  sh(mainRoot, 'add', '-A');
  sh(mainRoot, 'commit', '-q', '-m', 'init');
  sh(mainRoot, 'push', '-q', 'origin', 'main');
  return { root, url: sh(mainRoot, 'config', 'remote.origin.url'), base: sh(mainRoot, 'rev-parse', 'main') };
}

// Copies the template's origin.git and main into `dir`, a fresh mkdtemp directory, and returns main's SHA. git records
// a clone's origin by its real path with forward slashes, so `dir` is the real directory, never a link to it.
export function seedRepos(dir) {
  template ??= buildTemplate();
  cpSync(template.root, dir, { recursive: true });
  const config = join(dir, 'main', '.git', 'config');
  const text = readFileSync(config, 'utf8');
  const url = `${template.url.slice(0, -`${basename(template.root)}/origin.git`.length)}${basename(dir)}/origin.git`;
  if (dirname(dir) !== dirname(template.root) || text.split(template.url).length !== 2) throw new Error(`cannot point ${config} at ${url}`);
  writeFileSync(config, text.replace(template.url, url));
  return template.base;
}
