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

test('a declared skill is read whatever its policy, since its Agent names it', (t) => {
  const root = tempDirectory.tempDirectory(t, 'gg-skills-');
  mkdirSync(join(root, 'review-agent', 'agents'), { recursive: true });
  writeFileSync(join(root, 'review-agent', 'SKILL.md'), '---\nname: review-agent\ndescription: Reviews.\n---\n');
  writeFileSync(join(root, 'review-agent', 'agents', 'openai.yaml'), 'policy:\n  allow_implicit_invocation: false\n');
  assert.equal(codexSkills.skillAt(join(root, 'review-agent'))?.name, 'review-agent');
});
