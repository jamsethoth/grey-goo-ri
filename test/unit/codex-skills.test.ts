import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as codexSkills from '../../lib/harnesses/codex-skills.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// The skills list gg writes into a Codex call's prompt (#481 D2 A); codex-harness.test.ts lists them through a launch.

test("a skill's folded or multi-line description is listed whole", (t) => {
  const root = tempDirectory.tempDirectory(t, 'gg-skills-');
  const descriptions = {
    folded: '>\n  Use when asked to compress.\n  Trigger: /compress.',
    literal: '|-\n  First line.\n  Second line.',
  };
  for (const [folder, description] of Object.entries(descriptions)) {
    mkdirSync(join(root, folder));
    writeFileSync(join(root, folder, 'SKILL.md'), `---\nname: ${folder}\ndescription: ${description}\n---\n`);
  }
  const listed = codexSkills.listed(codexSkills.skillsIn(root));
  assert.match(listed, /^- folded: Use when asked to compress\. Trigger: \/compress\. \(file: /m);
  assert.match(listed, /^- literal: First line\. Second line\. \(file: /m);
});

// Codex's two bundled skills create-statusline and review-agent carry this policy, and Codex's own list leaves them
// out (#481 D7 A); a policy of true, or another key set false, leaves a skill in.
test('a skill whose agents/openai.yaml disallows implicit invocation is left out of the list', (t) => {
  const root = tempDirectory.tempDirectory(t, 'gg-skills-');
  const policies = {
    'request-only': 'interface:\n  display_name: "Request Only"\npolicy:\n  allow_implicit_invocation: false\n',
    'request-only-crlf': 'policy:\r\n  other: true\r\n  allow_implicit_invocation: false\r\n',
    implicit: 'policy:\n  allow_implicit_invocation: true\n',
    'other-false': 'interface:\n  allow_implicit_invocation: false\npolicy:\n  other: false\n',
    plain: null,
  };
  for (const [folder, policy] of Object.entries(policies)) {
    mkdirSync(join(root, folder, 'agents'), { recursive: true });
    writeFileSync(join(root, folder, 'SKILL.md'), `---\nname: ${folder}\ndescription: A skill.\n---\n`);
    if (policy !== null) writeFileSync(join(root, folder, 'agents', 'openai.yaml'), policy);
  }
  const names = codexSkills.skillsIn(root).map(({ name }) => name);
  assert.deepEqual(names.sort(), ['implicit', 'other-false', 'plain']);
});

test('a request-only setting after a blank line or under a commented `policy:` is still read', (t) => {
  const root = tempDirectory.tempDirectory(t, 'gg-skills-');
  const policies = {
    'blank-line': 'policy:\n  other: 1\n\n  allow_implicit_invocation: false\n',
    'commented-policy': 'policy: # note\n  allow_implicit_invocation: false\n',
  };
  for (const [folder, policy] of Object.entries(policies)) {
    mkdirSync(join(root, folder, 'agents'), { recursive: true });
    writeFileSync(join(root, folder, 'SKILL.md'), `---\nname: ${folder}\ndescription: A skill.\n---\n`);
    writeFileSync(join(root, folder, 'agents', 'openai.yaml'), policy);
  }
  assert.deepEqual(codexSkills.skillsIn(root), []);
});

// A listed plugin is named by its Agent, so its request-only skills are listed, each marked as Codex applies the
// policy (#481 D8 C); a bundled one stays out (D7 A).
test("a listed plugin's request-only skill is listed, marked to use only when named", (t) => {
  const root = tempDirectory.tempDirectory(t, 'gg-skills-');
  for (const folder of ['template', 'plain']) {
    mkdirSync(join(root, folder, 'agents'), { recursive: true });
    writeFileSync(join(root, folder, 'SKILL.md'), `---\nname: ${folder}\ndescription: A skill.\n---\n`);
  }
  writeFileSync(join(root, 'template', 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  const listed = codexSkills.listed(codexSkills.skillsIn(root, 'pages:', true));
  assert.match(listed, /^- pages:template: A skill\. \(use only when the task names this skill\) \(file: /m);
  assert.match(listed, /^- pages:plain: A skill\. \(file: /m);
});

test('a declared skill is read whatever its policy, since its Agent names it', (t) => {
  const root = tempDirectory.tempDirectory(t, 'gg-skills-');
  mkdirSync(join(root, 'review-agent', 'agents'), { recursive: true });
  writeFileSync(join(root, 'review-agent', 'SKILL.md'), '---\nname: review-agent\ndescription: Reviews.\n---\n');
  writeFileSync(join(root, 'review-agent', 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  assert.equal(codexSkills.skillAt(join(root, 'review-agent'))?.name, 'review-agent');
});

// A synchronous regular expression blocks the timer a test timeout runs on, so the case times the read and fails by
// name (#481 F24): the overlapping form took seconds at 20 comment lines.
test('a long commented policy block is read at once', (t) => {
  const root = tempDirectory.tempDirectory(t, 'gg-skills-');
  mkdirSync(join(root, 'commented', 'agents'), { recursive: true });
  writeFileSync(join(root, 'commented', 'SKILL.md'), '---\nname: commented\ndescription: A skill.\n---\n');
  writeFileSync(join(root, 'commented', 'agents', 'openai.yaml'), `policy:\n${'  # c\n'.repeat(22)}  x: 1\n`);
  const started = performance.now();
  const skills = codexSkills.skillsIn(root);
  const elapsedMs = performance.now() - started;
  assert.deepEqual(
    skills.map(({ name }) => name),
    ['commented'],
  );
  assert.ok(elapsedMs < 1000, `the policy read took ${Math.round(elapsedMs)} ms, so the request-only regex backtracks`);
});
