// The template repos every real-git fixture copies: each copy must be a repository of its own, or one case's commits
// would reach the next case's starting point.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { sh } from '../../support/git-shell.ts';
import * as tempDirectory from '../../support/temp-directory.ts';

// Equal refs do not show a copy owns its objects: a store shared through a link would pass a ref check.
const assertNoObject = (repos: string[], sha: string) => {
  for (const cwd of repos)
    assert.equal(spawnSync('git', ['cat-file', '-e', sha], { cwd }).status, 1, `${sha} reached ${cwd}`);
};
// A copy borrowing the template's objects through alternates passes the check above, but breaks once the template is
// repacked or removed.
const assertOwnObjects = (...dirs: string[]) => {
  for (const dir of dirs) {
    for (const store of [join(dir, 'main', '.git', 'objects'), join(dir, 'origin.git', 'objects')]) {
      assert.equal(existsSync(join(store, 'info', 'alternates')), false, `${store} borrows objects`);
    }
  }
};

test('a copied fixture repository is independent of its template', async (t) => {
  const templateRepos = await import('../../support/template-repos.ts');
  const changed = tempDirectory.tempDirectory(t, 'gg-git-');
  const untouched = tempDirectory.tempDirectory(t, 'gg-git-');
  const base = templateRepos.seedRepos(changed);
  templateRepos.seedRepos(untouched);
  writeFileSync(join(changed, 'main', 'a.txt'), 'a');
  sh(join(changed, 'main'), 'add', '-A');
  sh(join(changed, 'main'), 'commit', '-q', '-m', 'one');
  sh(join(changed, 'main'), 'push', '-q', 'origin', 'main');
  const later = tempDirectory.tempDirectory(t, 'gg-git-');

  assert.equal(templateRepos.seedRepos(later), base);
  assert.equal(sh(join(untouched, 'main'), 'rev-parse', 'main'), base);
  assert.equal(sh(join(untouched, 'origin.git'), 'rev-parse', 'main'), base);
  assert.equal(sh(join(later, 'main'), 'rev-parse', 'main'), base);
  assert.equal(sh(join(later, 'origin.git'), 'rev-parse', 'main'), base);
  assert.equal(sh(join(later, 'main'), 'status', '--porcelain'), '');
  // `later` is copied after the commit, so it also stands for the template's object stores.
  assertNoObject(
    [join(untouched, 'main'), join(untouched, 'origin.git'), join(later, 'main'), join(later, 'origin.git')],
    sh(join(changed, 'main'), 'rev-parse', 'HEAD'),
  );
  assertOwnObjects(changed, untouched, later);
});

test("a copied clone pushes to its own origin, not the template's", async (t) => {
  const templateRepos = await import('../../support/template-repos.ts');
  const pushed = tempDirectory.tempDirectory(t, 'gg-git-');
  templateRepos.seedRepos(pushed);
  sh(join(pushed, 'main'), 'checkout', '-q', '-b', 'ticket/9-thing');
  sh(join(pushed, 'main'), 'commit', '-q', '--allow-empty', '-m', 'work');
  sh(join(pushed, 'main'), 'push', '-q', 'origin', 'ticket/9-thing');
  const later = tempDirectory.tempDirectory(t, 'gg-git-');
  templateRepos.seedRepos(later);

  assert.equal(
    sh(join(pushed, 'origin.git'), 'rev-parse', 'ticket/9-thing'),
    sh(join(pushed, 'main'), 'rev-parse', 'HEAD'),
  );
  assert.equal(
    spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/ticket/9-thing'], {
      cwd: join(later, 'origin.git'),
    }).status,
    1,
  );
  assertNoObject([join(later, 'main'), join(later, 'origin.git')], sh(join(pushed, 'main'), 'rev-parse', 'HEAD'));
  assertOwnObjects(pushed, later);
});
