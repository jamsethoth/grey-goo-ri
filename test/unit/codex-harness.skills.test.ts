import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as codex from '../../lib/harnesses/codex.ts';
import type * as model from '../../lib/model.ts';
import * as cliReplay from '../support/cli-replay.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// The Codex Harness's skills list at the launch, beside codex-harness.test.ts, which is at its line cap.

const AGENT: model.Agent = {
  harness: 'codex',
  persona: 'reviewer.md',
  model: 'gpt-6.1-sol',
  effort: 'high',
  access: 'read-only',
  plugins: ['pages'],
  skills: ['review'],
};
const PLUGIN = { pluginId: 'pages@m', name: 'pages', marketplaceName: 'm', version: '1' };

// A skill Codex uses only on request: its agents/openai.yaml turns implicit invocation off.
function requestOnlySkill(root: string, name: string) {
  mkdirSync(join(root, name, 'agents'), { recursive: true });
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Does ${name}.\n---\n`);
  writeFileSync(join(root, name, 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
}

// Each request-only skill as its folder's caller decides: a bundled one stays out (D7 A), a declared one is listed as
// its Agent names it, a listed plugin's is listed marked (D8 C).
test('a request-only skill is listed when declared, marked from a listed plugin, left out when bundled', async (t) => {
  const home = tempDirectory.tempDirectory(t, 'gg-codex-home-');
  const plugin = join(home, 'plugins', 'cache', 'm', 'pages', '1');
  mkdirSync(join(plugin, '.codex-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.codex-plugin', 'plugin.json'), '{"name":"pages","skills":"./skills/"}');
  requestOnlySkill(join(plugin, 'skills'), 'publish');
  requestOnlySkill(join(home, 'skills', '.system'), 'installer');
  const cli = cliReplay.replayLaunch((args) => ({
    stdout: args[0] === 'plugin' ? JSON.stringify({ installed: [PLUGIN] }) : '[]',
    exitCode: 0,
  }));
  const skillsHome = tempDirectory.tempDirectory(t, 'gg-skills-');
  requestOnlySkill(skillsHome, 'review');
  const harness = codex.createCodex({ codexHome: home, skillsHome });
  const call = {
    marker: 'm',
    agent: AGENT,
    schema: {},
    cwd: 'cwd',
    resume: null,
    runDirectory: 'run',
    access: 'read-only',
  };
  const { skills } = harness.launchArgs(
    call,
    harness.resolveTools(AGENT, { commands: {}, platform: 'win32' }),
    await codex.list(cli, home),
  );
  assert.match(skills, /^- pages:publish: Does publish\. \(use only when the task names this skill\) \(file: /m);
  assert.match(skills, /^- review: Does review\. \(file: /m);
  assert.doesNotMatch(skills, /installer/);
});
