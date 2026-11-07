// A Procedure as declared, checked on its own: its Actions (actions.ts), Claim tokens, settings and Rule Table rows,
// and the order its Actions run in. What the Procedure's references read is typed later, alone and at each Vertex
// (references.ts).

import * as briefs from '../briefs.ts';
import * as procedures from '../procedures.ts';
import * as outcome from '../outcome.ts';
import * as referencePaths from '../reference-paths.ts';
import * as actionChecks from './actions.ts';
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
// A Claim token's two forms and the keys each may have.
export const CLAIM_TOKEN_FORMS = { requires: ['requires'], stop: ['stop', 'comment'] };
const CLAIM_TOKEN_SHAPE = 'a Claim token is { requires: [<check ids>] } or { stop: true, comment?: <file> }';

type Value = Record<string, unknown>;
// A Procedure as the validator checked it. Its parts are as declared, so a later check reads what an earlier one
// reported, and the Resolved Flow carries the actions, tables and settings as written.
export interface CheckedProcedure {
  name: string;
  location: string;
  agent: Value | null;
  schema: referencePaths.SchemaNode;
  actions: unknown[];
  checks: Value[];
  checkIds: unknown[];
  claimTokens: Record<string, procedures.ClaimToken>;
  tokens: Record<TableName, string[]>;
  tests: unknown;
  access: unknown;
  recover: unknown;
  tables: Record<TableName, unknown[]>;
  malformed: Set<TableName>;
  otherwise: unknown;
}

// The Check ids a Claim token requires that are Checks of the Procedure, each once.
const requiredOf = (claimTokens: Record<string, procedures.ClaimToken>, checkIds: unknown[], token: string) =>
  report.unique(claimTokens[token].requires ?? []).filter((id) => checkIds.includes(id));
export const requiredCheckIds = (proc: CheckedProcedure, token: string) =>
  requiredOf(proc.claimTokens, proc.checkIds, token);

// A stop token, or one requiring Checks of this Procedure; either way the form the Resolved Flow carries.
function checkClaimToken(problems: report.Report, token: unknown, checkIds: unknown[], location: string) {
  if (!referencePaths.isRecord(token)) {
    report.error(problems, location, 'malformed-claim-token', CLAIM_TOKEN_SHAPE);
    return { requires: [] };
  }
  const keysOf = (forms: string[]) => Object.keys(token).every((key) => forms.includes(key));
  if (token.stop === true && keysOf(CLAIM_TOKEN_FORMS.stop)) {
    if (token.comment !== undefined && !report.isName(token.comment))
      report.error(problems, location, 'file-not-named', 'comment must name a file');
  } else if (Array.isArray(token.requires) && keysOf(CLAIM_TOKEN_FORMS.requires)) {
    for (const id of token.requires) {
      if (!checkIds.includes(id))
        report.error(
          problems,
          location,
          'undeclared-check',
          `requires ${JSON.stringify(id)}, which is not a Check of this Procedure`,
        );
    }
  } else {
    report.error(problems, location, 'malformed-claim-token', CLAIM_TOKEN_SHAPE);
  }
  if (token.stop === true)
    return { stop: true as const, ...(token.comment !== undefined && { comment: token.comment as string }) };
  return { requires: Array.isArray(token.requires) ? (token.requires as string[]) : [] };
}

function checkClaimTokens(
  problems: report.Report,
  location: string,
  declaration: Value,
  declared: actionChecks.DeclaredSoFar,
) {
  const checkIds = declared.checks.map((check) => check.id);
  // No agent Action, so the implicit Claim ok requires every Check (R11f).
  if (!declared.agent) {
    if (declaration.claimTokens !== undefined) {
      report.error(
        problems,
        `${location}.claimTokens`,
        'claim-tokens-without-agent-action',
        'a Procedure with no agent Action declares no claimTokens: ' +
          'its implicit Claim ok requires every Check it declares',
      );
    }
    return { ok: { requires: checkIds as string[] } };
  }
  const declaredTokens = declaration.claimTokens;
  if (!referencePaths.isRecord(declaredTokens) || !Object.keys(declaredTokens).length) {
    report.error(
      problems,
      `${location}.claimTokens`,
      declaredTokens === undefined || referencePaths.isRecord(declaredTokens)
        ? 'claim-tokens-missing'
        : 'not-an-object',
      'a Procedure with an agent Action declares its claimTokens',
    );
    return {};
  }
  const claimTokens: Record<string, procedures.ClaimToken> = {};
  for (const [token, form] of Object.entries(declaredTokens)) {
    const atToken = `${location}.claimTokens.${token}`;
    report.checkName(problems, atToken, token, { what: 'Claim token', carried: false });
    if (report.isReserved(token))
      report.error(problems, atToken, 'reserved-name', `Claim token ${JSON.stringify(token)} ${report.RESERVED}`);
    claimTokens[token] = checkClaimToken(problems, form, checkIds, atToken);
  }
  if (declared.schema !== referencePaths.ANY) {
    try {
      briefs.assertClaimEnum(declared.schema, Object.keys(declaredTokens));
    } catch (err) {
      const message = `${declared.schemaName}: ${(err as Error).message}`;
      report.error(problems, `${location}.claimTokens`, 'claim-enum-mismatch', message);
    }
  }
  return claimTokens;
}

const namesTests = (tests: unknown) =>
  referencePaths.isRecord(tests) &&
  Object.keys(tests).length === 1 &&
  Object.hasOwn(tests, 'named') &&
  tests.named !== undefined;

function checkSettings(
  problems: report.Report,
  location: string,
  declaration: Value,
  declared: actionChecks.DeclaredSoFar,
) {
  const tests = declaration.tests ?? 'frozen';
  if (!(tests === 'frozen' || tests === 'write' || namesTests(tests)))
    report.error(
      problems,
      `${location}.tests`,
      'invalid-tests-setting',
      'tests must be frozen, write or { named: <reference path> }',
    );
  if (declaration.access !== undefined && declaration.access !== 'read-only')
    report.error(problems, `${location}.access`, 'invalid-procedure-access', 'access may only be read-only');
  const { recover } = declaration;
  if (recover === undefined) return tests;
  const wellFormed =
    referencePaths.isRecord(recover) &&
    report.isCount(recover.max) &&
    report.isName(recover.brief) &&
    Object.keys(recover).length === 2;
  if (!wellFormed)
    report.error(
      problems,
      `${location}.recover`,
      'malformed-recover',
      'recover is { max: <positive integer>, brief: <file> }',
    );
  else if (!declared.agent)
    report.error(
      problems,
      `${location}.recover`,
      'needs-agent-action',
      'recover resumes the agent Action, which this Procedure lacks',
    );
  return tests;
}

function checkTables(
  problems: report.Report,
  location: string,
  declaration: Value,
  tokens: Record<TableName, string[]>,
) {
  const tables = {} as Record<TableName, unknown[]>;
  const malformed = new Set<TableName>();
  for (const table of TABLES) {
    const rows = declaration[table] ?? [];
    tables[table] = Array.isArray(rows) ? rows : [];
    if (!Array.isArray(rows)) {
      report.error(problems, `${location}.${table}`, 'not-a-list', `${table} must be a list of rows`);
      continue;
    }
    if (rows.length && !tokens[table].length)
      report.error(
        problems,
        `${location}.${table}`,
        'table-never-applies',
        `${NO_TOKEN[table]}, so the ${table} table never applies`,
      );
    rows.forEach((row: unknown, index) => {
      const atRow = `${location}.${table}[${index}]`;
      const wellFormed =
        referencePaths.isRecord(row) &&
        referencePaths.isRecord(row.when) &&
        typeof row.outcome === 'string' &&
        Object.keys(row).length === 2;
      if (!wellFormed) {
        malformed.add(table);
        return report.error(
          problems,
          atRow,
          'malformed-row',
          'a row is { when: { <field>: <condition> }, outcome: <name> }',
        );
      }
      if (report.isReserved(row.outcome as string))
        report.error(problems, atRow, 'reserved-name', `outcome ${JSON.stringify(row.outcome)} ${report.RESERVED}`);
    });
  }
  return { tables, malformed };
}

function checkOtherwise(problems: report.Report, location: string, otherwise: unknown, decided: boolean) {
  if (otherwise === undefined) return;
  if (!report.isName(otherwise) || decided)
    report.error(problems, `${location}.otherwise`, 'invalid-otherwise', OTHERWISE[decided ? 'never' : 'unnamed']);
  else if (report.isReserved(otherwise))
    report.error(
      problems,
      `${location}.otherwise`,
      'reserved-name',
      `otherwise ${JSON.stringify(otherwise)} ${report.RESERVED}`,
    );
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
      for (const { code, message } of conditions.conditionProblems(check, declared.schema))
        report.error(problems, location, code, message);
    } else if (
      !Array.isArray(list) ||
      !list.length ||
      procedures.CONDITION_KEYS.some((key) => Object.hasOwn(check, key))
    )
      report.error(problems, location, 'malformed-all-of', 'allOf is a non-empty list of conditions, alone');
    else {
      list.forEach((condition, index) => {
        for (const { code, message } of conditions.conditionProblems(condition, declared.schema))
          report.error(problems, location, code, `allOf[${index}]: ${message}`);
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
      );
    }
  }
}

function tokensOf(claimTokens: Record<string, procedures.ClaimToken>, requiring: (token: string) => string[]) {
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
  if (!actions.length) {
    const code = report.absentOr(declaration.actions, Array.isArray(declaration.actions) ? 'empty-list' : 'not-a-list');
    report.error(problems, location, code, 'actions must be a non-empty list');
  }
  const declared = actionChecks.checkActions(declaring, actions, location);
  if (!declared.agent) actionChecks.checkCommitsWithoutAgent(problems, location, actions);
  const claimTokens = checkClaimTokens(problems, location, declaration, declared);
  const checkIds = declared.checks.map((check) => check.id);
  const tokens = tokensOf(claimTokens, (token) => requiredOf(claimTokens, checkIds, token));
  const tests = checkSettings(problems, location, declaration, declared);
  // A Decision takes the `passed` table's place (X1c), and otherwise's too where no Check can fail.
  const asking = !!procedures.approvalActionOf(actions);
  const { tables, malformed } = checkTables(
    problems,
    location,
    declaration,
    asking ? { ...tokens, passed: [] } : tokens,
  );
  checkOtherwise(problems, location, declaration.otherwise, asking && !tokens.failed.length);
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
    tests,
    access: declaration.access ?? null,
    recover: declaration.recover ?? null,
    tables,
    malformed,
    otherwise: declaration.otherwise,
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
