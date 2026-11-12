// The settings both gg.json files hold beside their Flows, checked before any Flow by gg doctor and gg run preflight
// alike (D7): the repository contract, the user's machine settings, and the keys each file may hold (ADR 0022).
import type * as config from './config.ts';
import * as referencePaths from './reference-paths.ts';
import * as report from './validate/report.ts';

// What each source's gg.json may hold. The repository contract is the repository's alone, whichever Flow runs, and the
// machine settings the person's (ADR 0022).
const FLOW_KEYS = ['flows', 'procedures', 'agents'];
const CONTRACT_KEYS = ['commands', 'testPaths', 'approvers', 'labelPrefix', 'baseBranch'];
const MACHINE_KEYS = ['maxParallel', 'worktreeRoot'];
// Request 3.9's migration table: a key feature-flow read, and where gg declares what it did. Its four stages became a
// Flow's Vertices.
const FEATURE_FLOW_KEYS = new Map([
  ['plan', 'flows'],
  ['implement', 'flows'],
  ['review', 'flows'],
  ['escalate', 'flows'],
  ['stageTools', 'agents'],
  ['toolkit', 'harnesses'],
  ['escalationEnabled', 'flows'],
  ['maxReviewRounds', 'flows'],
  ['contextBudget', 'agents'],
]);

// Each key of a source outside what it may hold, as an unknown-key Problem naming its file. `files` is gg's own.
function keyProblems(
  found: report.Report,
  source: config.Source,
  {
    file,
    prefix,
    allowed,
    misplaced,
  }: { file: string; prefix: string; allowed: string[]; misplaced: (key: string) => string | null },
) {
  for (const key of Object.keys(source)) {
    if (key === 'files' || allowed.includes(key)) continue;
    const replacement = FEATURE_FLOW_KEYS.get(key);
    const message =
      misplaced(key) ??
      `${file}: unknown key ${JSON.stringify(key)}` +
        (replacement ? `, which feature-flow read; gg declares it under ${replacement}` : '');
    report.error(found, `${prefix}${key}`, 'unknown-key', message, { key, file });
  }
}

// A labelPrefix holding ":" or whitespace splits every label gg reads back (lib/labels.ts).
const LABEL_PREFIX = /^[^\s:]+$/;
// git's branch-name rules (git check-ref-format), so a typo fails here and not at the first fetch.
const BRANCH =
  /^(?![-./])(?!.*(?:\.\.|\/\/|\/\.|@\{|\.lock\/))(?!.*(?:[/.]|\.lock)$)(?!(?:@|HEAD)$)[^\s\x00-\x1f\x7f~^:?*[\\]+$/;

// The repository's labelPrefix or baseBranch as Problems, naming `file`.
function nameProblems(
  found: report.Report,
  value: unknown,
  { key, file, missing, form, rule }: { key: string; file: string; missing: string; form: RegExp; rule: string },
) {
  if (value === undefined) report.error(found, key, 'required-key-missing', missing, { key, file });
  else if (typeof value !== 'string')
    report.error(found, key, 'not-a-string', `${file}: ${key} must be a string`, { file });
  else if (!form.test(value))
    report.error(found, key, 'invalid-name', `${file}: ${key} ${JSON.stringify(value)} must ${rule}`, {
      name: value,
      file,
    });
}

export function labelPrefixProblems(labelPrefix: unknown, file: string): report.Problem[] {
  const found = report.newReport();
  nameProblems(found, labelPrefix, {
    key: 'labelPrefix',
    file,
    missing: `${file} declares no labelPrefix; set "labelPrefix": "gg" in it`,
    form: LABEL_PREFIX,
    rule: 'be non-empty with no ":" or whitespace',
  });
  return found.errors;
}

export function baseBranchProblems(baseBranch: unknown, file: string): report.Problem[] {
  const found = report.newReport();
  nameProblems(found, baseBranch, {
    key: 'baseBranch',
    file,
    missing: `${file} declares no baseBranch; set it to the branch each Ticket's branch starts from`,
    form: BRANCH,
    rule:
      'be a branch name: not "@" or HEAD, not starting with "-", "." or "/", not ending with "/" or ".", with no ' +
      'part ending ".lock", and with no "..", "//", "/.", "@{", whitespace, control character or any of ~ ^ : ? * [ \\',
  });
  return found.errors;
}

// The user's machine settings as Problems, each at user:<key> and naming `file`.
function machineProblems(found: report.Report, user: config.Source, file: string) {
  const { maxParallel, worktreeRoot } = user;
  if (maxParallel === undefined) {
    const message = `${file} declares no maxParallel; set it to the most Tickets a Run carries at once`;
    report.error(found, 'user:maxParallel', 'required-key-missing', message, { key: 'maxParallel', file });
  } else if (!report.isCount(maxParallel)) {
    const message = `${file}: maxParallel must be a positive integer, the most Tickets a Run carries at once`;
    report.error(found, 'user:maxParallel', 'not-a-positive-integer', message, { file });
  }
  if (worktreeRoot === undefined) {
    const message = `${file} declares no worktreeRoot; set it to the directory ticket worktrees go under`;
    report.error(found, 'user:worktreeRoot', 'required-key-missing', message, { key: 'worktreeRoot', file });
  } else if (!report.isName(worktreeRoot)) {
    const message = `${file}: worktreeRoot must be a non-empty string`;
    report.error(found, 'user:worktreeRoot', 'not-a-string', message, { file });
  }
}

// What gg doctor and gg run preflight both check of the two gg.json files before any Flow: each key, the repository
// contract, the machine settings, and the repository's Flow names (D7).
export function sourceProblems({ repository, user, repositoryFile, userFile }: config.Configuration): report.Problem[] {
  const found = report.newReport();
  keyProblems(found, repository, {
    file: repositoryFile,
    prefix: '',
    allowed: [...CONTRACT_KEYS, ...FLOW_KEYS],
    misplaced: (key) =>
      MACHINE_KEYS.includes(key)
        ? `${repositoryFile}: ${key} is a machine setting, which only the user's gg.json declares, at ${userFile}`
        : null,
  });
  found.errors.push(...contractProblems(repository, repositoryFile));
  // An unqualified Flow name is the repository's and user:<name> the user's, so no Flow shadows another (Q18).
  for (const name of Object.keys(referencePaths.isRecord(repository.flows) ? repository.flows : {})) {
    if (!name.startsWith('user:')) continue;
    const message =
      `${repositoryFile}: Flow name ${JSON.stringify(name)} is reserved: user:<name> names a Flow in the user's ` +
      'directory';
    report.error(found, `flows.${name}`, 'reserved-name', message, { name, file: repositoryFile });
  }
  keyProblems(found, user, {
    file: userFile,
    prefix: 'user:',
    allowed: [...MACHINE_KEYS, ...FLOW_KEYS],
    misplaced: (key) =>
      CONTRACT_KEYS.includes(key)
        ? `${userFile}: ${key} belongs to the repository contract, which only the repository's gg.json declares, ` +
          `at ${repositoryFile}`
        : null,
  });
  machineProblems(found, user, userFile);
  return found.errors;
}

// The settings a Run reads, once sourceProblems has found none.
export const runSettings = ({ repository, user }: config.Configuration): config.Settings => ({
  labelPrefix: repository.labelPrefix as string,
  baseBranch: repository.baseBranch as string,
  worktreeRoot: user.worktreeRoot as string,
  maxParallel: user.maxParallel as number,
  commands: (repository.commands ?? {}) as config.Settings['commands'],
  testPaths: repository.testPaths as string[],
  ...(repository.approvers !== undefined && { approvers: repository.approvers as string[] }),
});

// Only globs that git's pathspecs (rollback) and checks.testPathMatcher (Test Immutability) read alike, and that git
// accepts inside the repository: git's `?` takes one byte of a UTF-8 name, and its brackets and backslash are syntax.
const badGlob = (glob: unknown): boolean =>
  typeof glob !== 'string' ||
  !glob.trim() ||
  /[[\]?\\:\x00-\x1f]/.test(glob) ||
  glob
    .split('/')
    .some((segment) => !segment || segment === '.' || segment === '..' || (segment.includes('**') && segment !== '**'));

// The repository's testPaths as Problems, each sentence naming `file`; none for a non-empty list of globs.
export function testPathsProblems(testPaths: unknown, file: string): report.Problem[] {
  const found = report.newReport();
  if (testPaths === undefined) {
    const message = `${file} declares no testPaths; merge {"testPaths":["<glob>"]} into it`;
    report.error(found, 'testPaths', 'required-key-missing', message, { key: 'testPaths', file });
  } else if (!Array.isArray(testPaths) || !testPaths.length) {
    const code = Array.isArray(testPaths) ? 'empty-list' : 'not-a-list';
    report.error(found, 'testPaths', code, `${file}: testPaths must be a non-empty list of glob strings`, { file });
  } else {
    testPaths.forEach((glob, index) => {
      if (!badGlob(glob)) return;
      const message =
        `${file}: testPaths entry ${JSON.stringify(glob)} must be a glob relative to the repository root: ` +
        'non-empty segments split by "/", no "." or ".." segment, "**" only as a whole segment, ' +
        'and no [ ] ? \\ : or control character';
      report.error(found, `testPaths[${index}]`, 'invalid-glob', message, { glob, file });
    });
  }
  return found.errors;
}

// The repository's approvers as Problems, naming `file`; none for no list or a list of logins.
export function approversProblems(approvers: unknown, file: string): report.Problem[] {
  const found = report.newReport();
  if (approvers === undefined) return found.errors;
  // A login with space around it never matches the actor GitHub names.
  const logins = Array.isArray(approvers) ? approvers : null;
  const valid = logins?.every((login) => typeof login === 'string' && login.trim() && login === login.trim());
  const message = `${file}: approvers must be a list of GitHub logins, each non-empty with no surrounding space`;
  if (!valid) report.error(found, 'approvers', logins ? 'invalid-name' : 'not-a-list', message, { file });
  return found.errors;
}

// The repository's Declared Commands as Problems, each sentence naming `file`; none for a valid set with a test.
export function commandProblems(declared: unknown, file: string): report.Problem[] {
  const found = report.newReport();
  const commands = declared === undefined ? {} : declared;
  if (!referencePaths.isRecord(commands)) {
    report.error(found, 'commands', 'not-an-object', `${file}: commands must be an object from name to command line`, {
      file,
    });
    return found.errors;
  }
  for (const [name, line] of Object.entries(commands)) {
    // A name that breaks the rule may hold any character, so it is located at commands, not in a path of its own.
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      const message = `${file}: command name "${name}" must match [a-z][a-z0-9-]*`;
      report.error(found, 'commands', 'invalid-name', message, { name, file });
    } else if (typeof line !== 'string' || !line.trim() || /[\r\n]/.test(line)) {
      const message = `${file}: command ${name} must be a non-empty single-line string`;
      report.error(found, `commands.${name}`, 'invalid-command-line', message, { command: name, file });
    }
  }
  if (!Object.hasOwn(commands, 'test')) {
    const message = `${file} declares no test command; merge {"commands":{"test":"<command line>"}} into it`;
    report.error(found, 'commands', 'required-key-missing', message, { key: 'test', file });
  }
  return found.errors;
}

// The repository contract at `file` as Problems: what gg run preflight and gg doctor both check of it (#301).
export const contractProblems = (repository: Record<string, unknown>, file: string): report.Problem[] => [
  ...commandProblems(repository.commands, file),
  ...testPathsProblems(repository.testPaths, file),
  ...approversProblems(repository.approvers, file),
  ...labelPrefixProblems(repository.labelPrefix, file),
  ...baseBranchProblems(repository.baseBranch, file),
];
