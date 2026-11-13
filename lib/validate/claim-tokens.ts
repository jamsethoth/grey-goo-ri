// A Procedure's Claim tokens checked (R11f): each token's form, its required Checks, and the agent Action's claim enum.
// Only lib/validate/procedures.ts imports it.

import * as briefs from '../briefs.ts';
import type * as procedures from '../procedures.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as actionChecks from './actions.ts';
import * as report from './report.ts';

type Value = Record<string, unknown>;
type Reported = report.Reported;
// A Claim token's two forms and the keys each may have.
export const CLAIM_TOKEN_FORMS = { requires: ['requires'], stop: ['stop', 'comment'] };
const CLAIM_TOKEN_SHAPE = 'a Claim token is { requires: [<check ids>] } or { stop: true, comment?: <file> }';
// A Claim token in its form as the later checks read it, its values as declared.
export type CheckedClaimToken =
  { requires: unknown[]; stop?: never } | { stop: true; comment?: unknown; requires?: never };

// The Checks a requires token names, each a Check of this Procedure, or Reported when one is not.
function requiredChecks(problems: report.Report, requires: unknown[], checkIds: string[], location: string) {
  const found: string[] = [];
  let refused: Reported | undefined;
  for (const id of requires) {
    const check = checkIds.find((checkId) => checkId === id);
    if (check !== undefined) found.push(check);
    else
      refused = report.error(
        problems,
        location,
        'undeclared-check',
        `requires ${JSON.stringify(id)}, which is not a Check of this Procedure`,
        { check: id },
      );
  }
  return refused ?? found;
}

// A stop token's comment, a file when it names one.
function stopComment(problems: report.Report, comment: unknown, location: string) {
  if (comment === undefined || report.isName(comment))
    return { stop: true as const, ...(comment !== undefined && { comment }) };
  return report.error(problems, location, 'file-not-named', 'comment must name a file', { key: 'comment' });
}

// A stop token, or one requiring Checks of this Procedure; either way the form the checks read, and the form the
// Resolved Flow carries, or Reported.
function checkClaimToken(problems: report.Report, token: unknown, checkIds: string[], location: string) {
  if (!referencePaths.isRecord(token)) {
    const typed = report.error(problems, location, 'malformed-claim-token', CLAIM_TOKEN_SHAPE);
    return { checked: { requires: [] }, typed };
  }
  const keysOf = (forms: string[]) => Object.keys(token).every((key) => forms.includes(key));
  let typed: procedures.ClaimToken | Reported;
  if (token.stop === true && keysOf(CLAIM_TOKEN_FORMS.stop)) typed = stopComment(problems, token.comment, location);
  else if (Array.isArray(token.requires) && keysOf(CLAIM_TOKEN_FORMS.requires)) {
    const requires = requiredChecks(problems, token.requires, checkIds, location);
    typed = report.isReported(requires) ? requires : { requires };
  } else typed = report.error(problems, location, 'malformed-claim-token', CLAIM_TOKEN_SHAPE);
  const checked: CheckedClaimToken =
    token.stop === true
      ? { stop: true as const, ...(token.comment !== undefined && { comment: token.comment }) }
      : { requires: Array.isArray(token.requires) ? token.requires : [] };
  return { checked, typed };
}

// What a Procedure's Claim tokens are checked against: where they sit, the Procedure as declared, its Actions so far,
// and its Checks' ids.
interface TokenContext {
  location: string;
  declaration: Value;
  declared: actionChecks.DeclaredSoFar;
  checkIds: string[];
}

// The Claim tokens as the checks read them, and as the Resolved Flow carries them, or Reported when one was.
export function checkClaimTokens(problems: report.Report, { location, declaration, declared, checkIds }: TokenContext) {
  // No agent Action, so the implicit Claim ok requires every Check (R11f).
  if (!declared.agent) {
    const implicit = { ok: { requires: checkIds } };
    if (declaration.claimTokens !== undefined) {
      const typed = report.error(
        problems,
        `${location}.claimTokens`,
        'claim-tokens-without-agent-action',
        'a Procedure with no agent Action declares no claimTokens: ' +
          'its implicit Claim ok requires every Check it declares',
      );
      return { checked: implicit, typed };
    }
    return { checked: implicit, typed: implicit };
  }
  const declaredTokens = declaration.claimTokens;
  // A present value that is not an object says so, rather than read as though the key were left out (#301).
  if (declaredTokens !== undefined && !referencePaths.isRecord(declaredTokens)) {
    const message = `claimTokens must be an object from token to form, not ${JSON.stringify(declaredTokens)}`;
    return {
      checked: {},
      typed: report.error(problems, `${location}.claimTokens`, 'not-an-object', message, { value: declaredTokens }),
    };
  }
  if (!referencePaths.isRecord(declaredTokens) || !Object.keys(declaredTokens).length) {
    const message = 'a Procedure with an agent Action declares its claimTokens';
    return { checked: {}, typed: report.error(problems, `${location}.claimTokens`, 'claim-tokens-missing', message) };
  }
  const before = problems.errors.length;
  const claimTokens: [string, CheckedClaimToken][] = [];
  const typed: [string, procedures.ClaimToken][] = [];
  for (const [token, form] of Object.entries(declaredTokens)) {
    const atToken = `${location}.claimTokens.${token}`;
    report.checkName(problems, atToken, token, { what: 'Claim token', carried: false });
    report.checkReserved(problems, atToken, 'Claim token', token);
    const checkedToken = checkClaimToken(problems, form, checkIds, atToken);
    claimTokens.push([token, checkedToken.checked]);
    if (!report.isReported(checkedToken.typed)) typed.push([token, checkedToken.typed]);
  }
  if (declared.schema !== referencePaths.ANY) {
    try {
      briefs.assertClaimEnum(declared.schema, Object.keys(declaredTokens));
    } catch (err) {
      const message = `${declared.schemaName}: ${(err as Error).message}`;
      const values = declared.schema.properties?.claim?.enum;
      const enumOf = Array.isArray(values) ? { enum: values } : {};
      const params = { schema: declared.schemaName as string, ...enumOf, tokens: Object.keys(declaredTokens) };
      report.error(problems, `${location}.claimTokens`, 'claim-enum-mismatch', message, params);
    }
  }
  // Built from entries, so a Claim token such as __proto__ is an own key.
  return {
    checked: Object.fromEntries(claimTokens),
    typed: report.reportedSince(problems, before) ?? Object.fromEntries(typed),
  };
}
