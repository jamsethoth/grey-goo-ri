import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as config from '../lib/config.mjs';
import * as flow from '../lib/flow.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const personaPath = (name) => join(repoRoot, 'defaults', 'personas', name);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Rebuilds an object with every key in reverse order, so only key order differs.
const reversed = (value) => Array.isArray(value) ? value.map(reversed)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
    : value;

test('loadDefaults reads the shipped agents, flow and personas', () => {
  const defaults = config.loadDefaults();
  assert.deepEqual(Object.keys(defaults.agents).sort(), ['implementer', 'reviewer']);
  assert.equal(defaults.agents.implementer.persona, 'implementer.md');
  assert.equal(defaults.agents.reviewer.persona, 'reviewer.md');
  assert.equal(defaults.flows.default.ticket.entry, 'implementer');
  for (const name of ['implementer.md', 'reviewer.md']) {
    const file = readFileSync(personaPath(name));
    const persona = defaults.personas[name];
    assert.ok(persona, `${name} is loaded`);
    assert.equal(String(persona.bytes), file.toString('utf8'));
    assert.equal(persona.hash, sha256(file));
  }
});

test('loadConfig reads the Layer identified by layerPath', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-layer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = config.layerPath(dir);
  assert.equal(file, join(dir, '.agents', 'gg', 'gg.json'));
  mkdirSync(join(dir, '.agents', 'gg'), { recursive: true });
  writeFileSync(file, '{"baseBranch":"layer-base"}');
  assert.equal(config.loadConfig(dir, join(dir, 'no-user-layer')).baseBranch, 'layer-base');
});

test('a Layer with a nodes key fails and names agents', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-layer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.agents', 'gg'), { recursive: true });
  writeFileSync(config.layerPath(dir), '{"nodes":{"implementer":{"harness":"claude"}}}');
  assert.throws(() => config.loadConfig(dir, join(dir, 'no-user-layer')), /"nodes".*"agents"/);
});

test('configHash changes with persona, vertex and command changes and ignores key order', () => {
  const defaults = config.loadDefaults();
  const base = {
    flow: flow.resolveFlow(defaults), personas: defaults.personas, harnesses: { claude: {} }, launchProfile: null,
    commands: { test: 'npm test' },
  };
  const hash = config.configHash(base);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(config.configHash(structuredClone(base)), hash, 'stable for equal input');
  assert.equal(config.configHash(reversed(base)), hash, 'stable across key order');

  const persona = structuredClone(base);
  const bytes = `${String(persona.personas['implementer.md'].bytes)} `;
  persona.personas['implementer.md'] = { bytes, hash: sha256(bytes) };
  assert.notEqual(config.configHash(persona), hash, 'a Persona byte changes the hash');

  const vertex = structuredClone(base);
  vertex.flow.ticket.vertices.reviewer.route.changes.max = 3;
  assert.notEqual(config.configHash(vertex), hash, 'a Vertex field changes the hash');

  const command = structuredClone(base);
  command.commands.test = 'npm run test:all';
  assert.notEqual(config.configHash(command), hash, 'a Declared Command changes the hash');
});

test('the shipped defaults name no harness, model or effort', () => {
  for (const [name, agent] of Object.entries(config.loadDefaults().agents)) {
    for (const key of ['harness', 'model', 'effort']) assert.equal(Object.hasOwn(agent, key), false, `${name} has no ${key}`);
  }
});

test('the Config Hash does not depend on the install path', async (t) => {
  // Two copies of gg installed under different roots must hash the shipped defaults the same.
  const hashes = [];
  for (const install of ['one', 'two']) {
    const root = join(mkdtempSync(join(tmpdir(), `gg-install-${install}-`)), 'gg');
    t.after(() => rmSync(join(root, '..'), { recursive: true, force: true }));
    for (const dir of ['lib', 'defaults']) cpSync(join(repoRoot, dir), join(root, dir), { recursive: true });
    const c = await import(pathToFileURL(join(root, 'lib', 'config.mjs')).href);
    const f = await import(pathToFileURL(join(root, 'lib', 'flow.mjs')).href);
    const defaults = c.loadDefaults();
    const input = { flow: f.resolveFlow(defaults), personas: defaults.personas, harnesses: {}, commands: {} };
    assert.ok(!JSON.stringify(input).includes(JSON.stringify(root).slice(1, -1)), 'no install path in the hashed input');
    hashes.push(c.configHash(input));
  }
  assert.equal(hashes[0], hashes[1]);
});

// Ported from feature-flow test/core.test.mjs (parseCommands, lib/config.mjs:79-95).
test('parseCommands reads the ## Commands section only', () => {
  const md = '# Repo\n- test: `nope`\n\n## Commands\n\n- test: `npm test`\n* Lint: `npm run lint`\n- run: `TODO`\n\n## Other\n- run: `x`\n';
  assert.deepEqual(config.parseCommands(md), { test: 'npm test', lint: 'npm run lint' });
});

test('parseCommands accepts hyphenated names', () => {
  assert.deepEqual(config.parseCommands('## Commands\n- lint-js: `x`\n'), { 'lint-js': 'x' });
});

test('parseCommands warns about duplicate names via the warn callback', () => {
  const warnings = [];
  const out = config.parseCommands('## Commands\n- test: `a`\n- test: `b`\n', (m) => warnings.push(m));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /test/);
  assert.equal(out.test, 'b');
});

test('parseCommands of this repository AGENTS.md declares the suite launcher as test', () => {
  const md = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');
  assert.deepEqual(config.parseCommands(md), { test: 'node scripts/run-suite.mjs' });
});

test('loadCommands reads AGENTS.md from the repository root and is empty without one', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gg-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(config.loadCommands(dir), {});
  writeFileSync(join(dir, 'AGENTS.md'), '# r\n\n## Commands\n\n- test: `npm test`\n');
  assert.deepEqual(config.loadCommands(dir), { test: 'npm test' });
});
