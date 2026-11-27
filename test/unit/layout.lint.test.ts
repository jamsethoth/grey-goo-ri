import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';

const root = fileURLToPath(new URL('../..', import.meta.url));

// A sample path such as lib/sample.ts is outside tsconfig.json's program, so these cases lint without types, and
// without gg's typed rules, as layout.test.ts's do.
const eslint = new ESLint({
  cwd: root,
  overrideConfig: [
    { files: ['**/*.ts'], ...tseslint.configs.disableTypeChecked },
    { rules: { 'gg/no-map-to-json': 'off', 'gg/no-json-parse-assertion': 'off' } },
  ],
});
const lintFindings = async (filePath: string, text: string) => {
  const [result] = await eslint.lintText(text, { filePath });
  return result.messages.map((message) => message.ruleId);
};

// throwIfNoEntry suppresses only a missing path: one gg cannot read still throws, so a PATH entry or --repo read with
// it fails on an unreachable share. lib/path-entry.ts reads an entry without it (#548).
test('lint fails throwIfNoEntry in lib, bin and scripts', async () => {
  const text =
    "import { lstatSync } from 'node:fs';\n\nexport const entry = lstatSync('x', { throwIfNoEntry: false });\n";
  for (const filePath of ['lib/sample.ts', 'lib/harnesses/sample.ts', 'bin/sample.ts', 'scripts/sample.ts'])
    assert.deepEqual(await lintFindings(filePath, text), ['no-restricted-syntax'], filePath);
});

// The option's name, wherever it is written: a quoted key fails the format check, but these two pass it.
test('lint fails throwIfNoEntry as a computed key or a member assignment', async () => {
  const forms = {
    computed:
      "import { lstatSync } from 'node:fs';\n\nexport const entry = lstatSync('x', { ['throwIfNoEntry']: false });\n",
    member: 'export const quiet = (options: Record<string, boolean>) => {\n  options.throwIfNoEntry = false;\n};\n',
  };
  for (const [form, text] of Object.entries(forms))
    assert.deepEqual(await lintFindings('lib/sample.ts', text), ['no-restricted-syntax'], form);
});
