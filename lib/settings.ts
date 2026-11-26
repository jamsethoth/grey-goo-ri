// The settings both gg.json files hold beside their Flows, checked before any Flow by gg doctor and gg run preflight
// alike (D7): the repository contract, the user's machine settings, and the keys each file may hold (ADR 0022). Each
// check gives the setting it judged, or Reported where it reported, so nothing judges a setting again (#391).
import type * as config from './config.ts';
import * as referencePaths from './reference-paths.ts';
import * as report from './validate/report.ts';

type Reported = report.Reported;

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
  ['toolkit', 'plugins'],
  ['escalationEnabled', 'flows'],
  ['maxReviewRounds', 'flows'],
  ['contextBudget', 'agents'],
]);

// Each key of a source outside what it may hold, as an unknown-key Problem naming its file.
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
    if (allowed.includes(key)) continue;
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

// The repository's labelPrefix or baseBranch, or Reported naming `file`.
function nameOf(
  found: report.Report,
  value: unknown,
  { key, file, missing, form, rule }: { key: string; file: string; missing: string; form: RegExp; rule: string },
): string | Reported {
  if (value === undefined) return report.error(found, key, 'required-key-missing', missing, { key, file });
  if (typeof value !== 'string')
    return report.error(found, key, 'not-a-string', `${file}: ${key} must be a string`, { file });
  if (form.test(value)) return value;
  return report.error(found, key, 'invalid-name', `${file}: ${key} ${JSON.stringify(value)} must ${rule}`, {
    name: value,
    file,
  });
}

const labelPrefixOf = (found: report.Report, labelPrefix: unknown, file: string) =>
  nameOf(found, labelPrefix, {
    key: 'labelPrefix',
    file,
    missing: `${file} declares no labelPrefix; set "labelPrefix": "gg" in it`,
    form: LABEL_PREFIX,
    rule: 'be non-empty with no ":" or whitespace',
  });

export function labelPrefixProblems(labelPrefix: unknown, file: string): report.Problem[] {
  const found = report.newReport();
  labelPrefixOf(found, labelPrefix, file);
  return found.errors;
}

const baseBranchOf = (found: report.Report, baseBranch: unknown, file: string) =>
  nameOf(found, baseBranch, {
    key: 'baseBranch',
    file,
    missing: `${file} declares no baseBranch; set it to the branch each Ticket's branch starts from`,
    form: BRANCH,
    rule:
      'be a branch name: not "@" or HEAD, not starting with "-", "." or "/", not ending with "/" or ".", with no ' +
      'part ending ".lock", and with no "..", "//", "/.", "@{", whitespace, control character or any of ~ ^ : ? * [ \\',
  });

// The user's maxParallel, or Reported at user:maxParallel naming `file`.
function maxParallelOf(found: report.Report, maxParallel: unknown, file: string): number | Reported {
  if (maxParallel === undefined) {
    const message = `${file} declares no maxParallel; set it to the most Tickets a Run carries at once`;
    return report.error(found, 'user:maxParallel', 'required-key-missing', message, { key: 'maxParallel', file });
  }
  if (report.isCount(maxParallel)) return maxParallel;
  const message = `${file}: maxParallel must be a positive integer, the most Tickets a Run carries at once`;
  return report.error(found, 'user:maxParallel', 'not-a-positive-integer', message, { file });
}

// The user's worktreeRoot, or Reported at user:worktreeRoot naming `file`.
function worktreeRootOf(found: report.Report, worktreeRoot: unknown, file: string): string | Reported {
  if (worktreeRoot === undefined) {
    const message = `${file} declares no worktreeRoot; set it to the directory ticket worktrees go under`;
    return report.error(found, 'user:worktreeRoot', 'required-key-missing', message, { key: 'worktreeRoot', file });
  }
  if (report.isName(worktreeRoot)) return worktreeRoot;
  const message = `${file}: worktreeRoot must be a non-empty string`;
  return report.error(found, 'user:worktreeRoot', 'not-a-string', message, { file });
}

// An unqualified Flow name is the repository's and user:<name> the user's, so no Flow shadows another (Q18).
function reservedNameProblems(found: report.Report, repository: config.Source, file: string) {
  for (const name of Object.keys(referencePaths.isRecord(repository.flows) ? repository.flows : {})) {
    if (!name.startsWith('user:')) continue;
    const message =
      `${file}: Flow name ${JSON.stringify(name)} is reserved: user:<name> names a Flow in the user's ` + 'directory';
    report.error(found, `flows.${name}`, 'reserved-name', message, { name, file });
  }
}

// The two gg.json files' settings: Settings when they hold no error, else the errors, never both, so tsc stops a
// caller reading Settings it has not checked (#362). Beside the errors come the Declared Commands when none of the
// errors is theirs, so preflight still checks each Harness with them (D5 of #422).
type ParsedSettings =
  | { settings: config.Settings; errors?: never; commands?: never }
  | { errors: report.Problem[]; settings?: never; commands?: Record<string, string> };

// What gg doctor and gg run preflight both check of the two gg.json files before any Flow (D7): each key, the
// repository contract, the repository's Flow names, and the machine settings.
export function parse({ repository, user, repositoryFile, userFile }: config.Configuration): ParsedSettings {
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
  const { commands, testPaths, approvers, labelPrefix, baseBranch } = contractOf(found, repository, repositoryFile);
  reservedNameProblems(found, repository, repositoryFile);
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
  const maxParallel = maxParallelOf(found, user.maxParallel, userFile);
  const worktreeRoot = worktreeRootOf(found, user.worktreeRoot, userFile);
  if (
    report.isReported(commands) ||
    report.isReported(testPaths) ||
    report.isReported(approvers) ||
    report.isReported(labelPrefix) ||
    report.isReported(baseBranch) ||
    report.isReported(maxParallel) ||
    report.isReported(worktreeRoot) ||
    found.errors.length
  )
    return { errors: found.errors, ...(!report.isReported(commands) && { commands }) };
  return {
    settings: {
      labelPrefix,
      baseBranch,
      worktreeRoot,
      maxParallel,
      commands,
      testPaths,
      ...(approvers !== undefined && { approvers }),
    },
  };
}

// Only globs that git's pathspecs (rollback) and checks.testPathMatcher (Test Immutability) read alike, and that git
// accepts inside the repository: git's `?` takes one byte of a UTF-8 name, and its brackets and backslash are syntax.
const isGlob = (glob: unknown): glob is string =>
  typeof glob === 'string' &&
  !!glob.trim() &&
  !/[[\]?\\:\x00-\x1f]/.test(glob) &&
  !glob
    .split('/')
    .some((segment) => !segment || segment === '.' || segment === '..' || (segment.includes('**') && segment !== '**'));

// The repository's testPaths, or Reported, each sentence naming `file`.
function testPathsOf(found: report.Report, testPaths: unknown, file: string): string[] | Reported {
  if (testPaths === undefined) {
    const message = `${file} declares no testPaths; merge {"testPaths":["<glob>"]} into it`;
    return report.error(found, 'testPaths', 'required-key-missing', message, { key: 'testPaths', file });
  }
  if (!Array.isArray(testPaths) || !testPaths.length) {
    const code = Array.isArray(testPaths) ? 'empty-list' : 'not-a-list';
    const message = `${file}: testPaths must be a non-empty list of glob strings`;
    return report.error(found, 'testPaths', code, message, { file });
  }
  const before = found.errors.length;
  const globs: string[] = [];
  for (const [index, glob] of (testPaths as unknown[]).entries()) {
    if (isGlob(glob)) {
      globs.push(glob);
      continue;
    }
    const message =
      `${file}: testPaths entry ${JSON.stringify(glob)} must be a glob relative to the repository root: ` +
      'non-empty segments split by "/", no "." or ".." segment, "**" only as a whole segment, ' +
      'and no [ ] ? \\ : or control character';
    report.error(found, `testPaths[${index}]`, 'invalid-glob', message, { glob, file });
  }
  return report.reportedSince(found, before) ?? globs;
}

// A login with space around it never matches the actor GitHub names.
const isLogin = (login: unknown): login is string =>
  typeof login === 'string' && !!login.trim() && login === login.trim();

// The repository's approvers, undefined for none, or Reported naming `file`.
function approversOf(found: report.Report, approvers: unknown, file: string): string[] | undefined | Reported {
  if (approvers === undefined) return undefined;
  const message = `${file}: approvers must be a list of GitHub logins, each non-empty with no surrounding space`;
  if (!Array.isArray(approvers)) return report.error(found, 'approvers', 'not-a-list', message, { file });
  const logins = approvers as unknown[];
  if (logins.every(isLogin)) return logins;
  return report.error(found, 'approvers', 'invalid-name', message, { file });
}

// The repository's Declared Commands, or Reported, each sentence naming `file`; a valid set has a test.
function commandsOf(found: report.Report, declared: unknown, file: string): Record<string, string> | Reported {
  const commands = declared === undefined ? {} : declared;
  if (!referencePaths.isRecord(commands)) {
    const message = `${file}: commands must be an object from name to command line`;
    return report.error(found, 'commands', 'not-an-object', message, { file });
  }
  const before = found.errors.length;
  const lines: Record<string, string> = {};
  for (const [name, line] of Object.entries(commands)) {
    // A name that breaks the rule may hold any character, so it is located at commands, not in a path of its own.
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      const message = `${file}: command name "${name}" must match [a-z][a-z0-9-]*`;
      report.error(found, 'commands', 'invalid-name', message, { name, file });
    } else if (typeof line !== 'string' || !line.trim() || /[\r\n]/.test(line)) {
      const message = `${file}: command ${name} must be a non-empty single-line string`;
      report.error(found, `commands.${name}`, 'invalid-command-line', message, { command: name, file });
    } else lines[name] = line;
  }
  if (!Object.hasOwn(commands, 'test')) {
    const message = `${file} declares no test command; merge {"commands":{"test":"<command line>"}} into it`;
    report.error(found, 'commands', 'required-key-missing', message, { key: 'test', file });
  }
  return report.reportedSince(found, before) ?? lines;
}

// The repository contract at `file`, each setting as its check gives it: what gg run preflight and gg doctor both
// check of it (#301).
const contractOf = (found: report.Report, repository: config.Source, file: string) => ({
  commands: commandsOf(found, repository.commands, file),
  testPaths: testPathsOf(found, repository.testPaths, file),
  approvers: approversOf(found, repository.approvers, file),
  labelPrefix: labelPrefixOf(found, repository.labelPrefix, file),
  baseBranch: baseBranchOf(found, repository.baseBranch, file),
});
