// A Procedure as declared, checked on its own: its Actions (actions.ts), Claim tokens, settings and Rule Table rows,
// and the order its Actions run in. What the Procedure's references read is typed later, alone and at each Vertex
// (references.ts).

import * as briefs from '../briefs.ts';
import * as procedures from '../procedures.ts';
import * as outcome from '../outcome.ts';
import * as referencePaths from '../reference-paths.ts';
import * as actionChecks from './actions.ts';
import * as claimTokenChecks from './claim-tokens.ts';
import * as rules from '../rules.ts';
import * as conditions from './conditions.ts';
import * as report from './report.ts';

export type TableName = 'passed' | 'failed' | 'stopped';
export const TABLES: TableName[] = ['passed', 'failed', 'stopped'];
// The tokens some input falls through each table for.
export type FallThroughs = Partial<Record<TableName, string[]>>;
// A way a Procedure produces an Outcome: a Claim token through one table, or a harness failure (table null).
export interface OutcomeCase {
  outcome: string;
  table: TableName | null;
  token: string | null;
}
const OTHERWISE = {
  never: 'otherwise never applies: a Decision is the Outcome',
  unnamed: 'otherwise must name an Outcome',
};
const NO_TOKEN: Record<TableName, string> = {
  passed: 'no Claim token passes, or a Decision is the Outcome of a Visit whose Checks passed',
  failed: 'no Claim token requires a Check',
  stopped: 'no Claim token stops',
};

export const PROCEDURE_KEYS = ['tests', 'access', 'claimTokens', 'actions', 'recover', ...TABLES, 'otherwise'];
type Value = Record<string, unknown>;
type Reported = report.Reported;
// A Procedure as the validator checked it. Its parts are as declared, so a later check reads what an earlier one
// reported, and the Resolved Flow carries the actions, tables and settings as written.
export interface CheckedProcedure {
  name: string;
  location: string;
  agent: Value | null;
  schema: referencePaths.SchemaNode;
  actions: unknown[];
  checks: Value[];
  checkIds: string[];
  claimTokens: Record<string, claimTokenChecks.CheckedClaimToken>;
  tokens: Record<TableName, string[]>;
  tests: unknown;
  access: unknown;
  recover: unknown;
  tables: Record<TableName, unknown[]>;
  malformed: Set<TableName>;
  otherwise: unknown;
  typed: TypedProcedure;
}
// What the Resolved Flow carries of a Procedure, each part as its check typed it, or Reported where it reported. A
// part is undefined where the check that refuses it is references.ts's, which reports it by the same rule: a tests
// path that is not a string (malformed-reference), and a row condition rules.isCondition refuses
// (invalid-rule-condition).
export interface TypedProcedure {
  actions: procedures.Action[] | Reported;
  claimTokens: Record<string, procedures.ClaimToken> | Reported;
  tests: procedures.Procedure['tests'] | Reported | undefined;
  access: 'read-only' | null | Reported;
  recover: procedures.Procedure['recover'] | Reported;
  passed: rules.RuleRow[] | Reported | undefined;
  failed: rules.RuleRow[] | Reported | undefined;
  stopped: rules.RuleRow[] | Reported | undefined;
  otherwise: string | null | Reported;
}

// The Checks' ids that are strings; any other is reported at its Action and kept out of what is keyed by id (#174).
const checkIdsOf = (declared: actionChecks.DeclaredSoFar) =>
  declared.checks.map((check) => check.id).filter((id): id is string => typeof id === 'string');

// The Check ids a Claim token requires that are Checks of the Procedure, each once.
const requiredOf = (
  claimTokens: Record<string, claimTokenChecks.CheckedClaimToken>,
  checkIds: string[],
  token: string,
) =>
  report
    .unique(claimTokens[token].requires ?? [])
    .filter((id): id is string => checkIds.some((checkId) => checkId === id));
export const requiredCheckIds = (proc: CheckedProcedure, token: string) =>
  requiredOf(proc.claimTokens, proc.checkIds, token);

// The tests setting: frozen, write, or the path its named tests are read from. A named path that is not a string is
// references.ts's to report.
function checkTests(
  problems: report.Report,
  location: string,
  tests: unknown,
): procedures.Procedure['tests'] | Reported | undefined {
  if (tests === 'frozen' || tests === 'write') return tests;
  if (referencePaths.isRecord(tests) && Object.keys(tests).length === 1 && tests.named !== undefined)
    return typeof tests.named === 'string' ? { named: tests.named } : undefined;
  return report.error(
    problems,
    `${location}.tests`,
    'invalid-tests-setting',
    'tests must be frozen, write or { named: <reference path> }',
  );
}

function checkRecover(
  problems: report.Report,
  location: string,
  recover: unknown,
  declared: actionChecks.DeclaredSoFar,
) {
  if (recover === undefined) return null;
  if (
    !referencePaths.isRecord(recover) ||
    !report.isCount(recover.max) ||
    !report.isName(recover.brief) ||
    Object.keys(recover).length !== 2
  )
    return report.error(
      problems,
      `${location}.recover`,
      'malformed-recover',
      'recover is { max: <positive integer>, brief: <file> }',
    );
  if (!declared.agent)
    return report.error(
      problems,
      `${location}.recover`,
      'needs-agent-action',
      'recover resumes the agent Action, which this Procedure lacks',
    );
  return { max: recover.max, brief: recover.brief };
}

function checkSettings(
  problems: report.Report,
  location: string,
  declaration: Value,
  declared: actionChecks.DeclaredSoFar,
) {
  const tests = declaration.tests ?? 'frozen';
  const typedTests = checkTests(problems, location, tests);
  let access: 'read-only' | null | Reported = null;
  if (declaration.access === 'read-only') access = 'read-only';
  else if (declaration.access !== undefined)
    access = report.error(problems, `${location}.access`, 'invalid-procedure-access', 'access may only be read-only');
  const recover = checkRecover(problems, location, declaration.recover, declared);
  return { tests, typed: { tests: typedTests, access, recover } };
}

// A row's conditions, or undefined when one is not a condition (rules.isCondition), which references.ts reports.
function conditionsOf(when: Value) {
  const conditions: [string, rules.Condition][] = [];
  for (const [path, condition] of Object.entries(when)) {
    if (!rules.isCondition(condition)) return undefined;
    conditions.push([path, condition]);
  }
  // Built from entries, so a field such as __proto__ is an own key.
  return Object.fromEntries(conditions);
}

function checkTables(
  problems: report.Report,
  location: string,
  declaration: Value,
  tokens: Record<TableName, string[]>,
) {
  const tables = {} as Record<TableName, unknown[]>;
  const typed = {} as Record<TableName, rules.RuleRow[] | Reported | undefined>;
  const malformed = new Set<TableName>();
  for (const table of TABLES) {
    const rows = declaration[table] ?? [];
    tables[table] = Array.isArray(rows) ? rows : [];
    if (!Array.isArray(rows)) {
      const message = `${table} must be a list of rows`;
      typed[table] = report.error(problems, `${location}.${table}`, 'not-a-list', message, { table });
      continue;
    }
    const before = problems.errors.length;
    const typedRows: rules.RuleRow[] = [];
    let unjudged = false;
    if (rows.length && !tokens[table].length)
      report.error(
        problems,
        `${location}.${table}`,
        'table-never-applies',
        `${NO_TOKEN[table]}, so the ${table} table never applies`,
        { table },
      );
    rows.forEach((row: unknown, index) => {
      const atRow = `${location}.${table}[${index}]`;
      if (
        !referencePaths.isRecord(row) ||
        !referencePaths.isRecord(row.when) ||
        typeof row.outcome !== 'string' ||
        Object.keys(row).length !== 2
      ) {
        malformed.add(table);
        return report.error(
          problems,
          atRow,
          'malformed-row',
          'a row is { when: { <field>: <condition> }, outcome: <name> }',
        );
      }
      report.checkReserved(problems, atRow, 'outcome', row.outcome);
      const when = conditionsOf(row.when);
      if (when) typedRows.push({ when, outcome: row.outcome });
      else unjudged = true;
    });
    typed[table] = report.reportedSince(problems, before) ?? (unjudged ? undefined : typedRows);
  }
  return { tables, typed, malformed };
}

function checkOtherwise(problems: report.Report, location: string, otherwise: unknown, decided: boolean) {
  if (otherwise === undefined) return null;
  if (!report.isName(otherwise) || decided)
    return report.error(
      problems,
      `${location}.otherwise`,
      'invalid-otherwise',
      OTHERWISE[decided ? 'never' : 'unnamed'],
    );
  const before = problems.errors.length;
  report.checkReserved(problems, `${location}.otherwise`, 'otherwise', otherwise);
  return report.reportedSince(problems, before) ?? otherwise;
}

function checkResponseConditions(problems: report.Report, declared: actionChecks.DeclaredSoFar) {
  for (const [check, location] of declared.responseConditions) {
    if (!declared.agent) {
      report.error(
        problems,
        location,
        'needs-agent-action',
        "a response Check reads the agent Action's response, which this Procedure lacks",
      );
      continue;
    }
    const list = check.allOf;
    if (list === undefined) {
      for (const finding of conditions.conditionProblems(check, declared.schema))
        report.errorOf(problems, location, finding);
    } else if (
      !Array.isArray(list) ||
      !list.length ||
      procedures.CONDITION_KEYS.some((key) => Object.hasOwn(check, key))
    )
      report.error(problems, location, 'malformed-all-of', 'allOf is a non-empty list of conditions, alone');
    else {
      list.forEach((condition, index) => {
        for (const finding of conditions.conditionProblems(condition, declared.schema))
          report.errorOf(problems, location, { ...finding, message: `allOf[${index}]: ${finding.message}` });
      });
    }
  }
}

// pr-ready runs only on fresh passing Checks, so every token it can run under requires one (R11d).
function checkPrReady(problems: report.Report, proc: CheckedProcedure) {
  const ready = proc.actions.findIndex((action) => referencePaths.isRecord(action) && action.do === 'pr-ready');
  for (const token of ready === -1 ? [] : proc.tokens.passed) {
    if (!proc.claimTokens[token].requires?.length) {
      report.error(
        problems,
        `${proc.location}.actions[${ready}]`,
        'pr-ready-without-checks',
        `pr-ready publishes only after passing Checks, but Claim token ${token} requires none`,
        { token },
      );
    }
  }
}

function tokensOf(
  claimTokens: Record<string, claimTokenChecks.CheckedClaimToken>,
  requiring: (token: string) => string[],
) {
  const passing = Object.keys(claimTokens).filter((token) => !claimTokens[token].stop);
  return {
    passed: passing,
    failed: passing.filter((token) => requiring(token).length),
    stopped: Object.keys(claimTokens).filter((token) => claimTokens[token].stop),
  };
}

// Checks one declared Procedure, or reports that it is not an object.
export function checkProcedure(
  declaring: actionChecks.ProcedureContext,
  name: string,
  declaration: unknown,
): CheckedProcedure | undefined {
  const location = `procedures.${name}`;
  const problems = declaring.report;
  report.checkName(problems, location, name, { what: 'Procedure', carried: true });
  if (!referencePaths.isRecord(declaration)) {
    report.error(problems, location, 'not-an-object', 'a Procedure must be an object');
    return undefined;
  }
  report.unknownKeys(problems, declaration, PROCEDURE_KEYS, location);
  const actions: unknown[] = Array.isArray(declaration.actions) ? declaration.actions : [];
  let noActions: Reported | undefined;
  if (!actions.length) {
    const code = Array.isArray(declaration.actions) ? 'empty-list' : 'not-a-list';
    const message = 'actions must be a non-empty list';
    noActions = report.errorOf(problems, location, report.absentOr(declaration.actions, 'actions', code, message));
  }
  const { declared, typed: typedActions } = actionChecks.checkActions(declaring, actions, location);
  if (!declared.agent) actionChecks.checkCommitsWithoutAgent(problems, location, actions);
  const checkIds = checkIdsOf(declared);
  const tokenContext = { location, declaration, declared, checkIds };
  const { checked: claimTokens, typed: typedTokens } = claimTokenChecks.checkClaimTokens(problems, tokenContext);
  const tokens = tokensOf(claimTokens, (token) => requiredOf(claimTokens, checkIds, token));
  const settings = checkSettings(problems, location, declaration, declared);
  // A Decision takes the `passed` table's place (X1c), and otherwise's too where no Check can fail.
  const asking = !!procedures.approvalActionOf(actions);
  const tableTokens = asking ? { ...tokens, passed: [] } : tokens;
  const { tables, typed: rows, malformed } = checkTables(problems, location, declaration, tableTokens);
  const otherwise = checkOtherwise(problems, location, declaration.otherwise, asking && !tokens.failed.length);
  checkResponseConditions(problems, declared);
  actionChecks.checkOrder(problems, location, actions);
  const proc: CheckedProcedure = {
    name,
    location,
    agent: declared.agent,
    schema: declared.schema,
    actions,
    checks: declared.checks,
    checkIds,
    claimTokens,
    tokens,
    tests: settings.tests,
    access: declaration.access ?? null,
    recover: declaration.recover ?? null,
    tables,
    malformed,
    otherwise: report.isName(declaration.otherwise) ? declaration.otherwise : undefined, // reported, kept out (#174)
    typed: { actions: noActions ?? typedActions, claimTokens: typedTokens, ...settings.typed, ...rows, otherwise },
  };
  checkPrReady(problems, proc);
  return proc;
}

// The Outcomes a Procedure can produce (R12b, T7): each table's rows, and its default when some input falls through.
// `falls` holds the tokens some input falls through a table for; every token reaching a table that was not analysed
// falls through.
export function outcomesOf(proc: CheckedProcedure, falls: FallThroughs) {
  const { tokens, tables, otherwise } = proc;
  const found: string[] = [];
  const add = (table: TableName, fallback: (fell: string[]) => unknown[]) => {
    if (!tokens[table].length) return;
    const rows = tables[table].map((row) => (referencePaths.isRecord(row) ? row.outcome : undefined));
    found.push(...(rows.filter((name) => typeof name === 'string') as string[]));
    const fell = falls[table] ?? tokens[table];
    if (fell.length) found.push(...(fallback(fell) as string[]));
  };
  const asking = procedures.approvalActionOf(proc.actions);
  const decided = otherwise ? [otherwise] : null;
  add('passed', (fell) => (asking ? procedures.decisionsOf(asking) : (decided ?? fell)));
  add('failed', () => [otherwise ?? 'failed']);
  add('stopped', (fell) => fell);
  if (proc.agent) found.push(...outcome.HARNESS_OUTCOMES);
  return report.unique(found);
}

// The ways a Procedure produces each Outcome (H3): each row of a table counting for every token of it (H2), and the
// default for each token that falls through (outcomesOf, a token at a time); or a harness failure.
export function casesOf(proc: CheckedProcedure, falls: FallThroughs) {
  const cases: OutcomeCase[] = [];
  for (const table of TABLES) {
    for (const token of proc.tokens[table]) {
      const tokens = Object.fromEntries(TABLES.map((each) => [each, each === table ? [token] : []]));
      const fell = falls[table] ? { [table]: falls[table].filter((name) => name === token) } : {};
      const alone = { ...proc, agent: null, tokens } as CheckedProcedure;
      for (const name of outcomesOf(alone, fell)) cases.push({ outcome: name, table, token });
    }
  }
  if (proc.agent) cases.push(...outcome.HARNESS_OUTCOMES.map((name) => ({ outcome: name, table: null, token: null })));
  return cases;
}
