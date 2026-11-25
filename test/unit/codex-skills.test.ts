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
