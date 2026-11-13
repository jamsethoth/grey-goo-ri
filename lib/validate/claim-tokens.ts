// A Procedure's Claim tokens checked (R11f): each token's form, its required Checks, and the agent Action's claim enum.
// Only lib/validate/procedures.ts imports it.

import * as briefs from '../briefs.ts';
import * as referencePaths from '../reference-paths.ts';
import type * as actionChecks from './actions.ts';
import * as report from './report.ts';

type Value = Record<string, unknown>;
// A Claim token's two forms and the keys each may have.
export const CLAIM_TOKEN_FORMS = { requires: ['requires'], stop: ['stop', 'comment'] };
const CLAIM_TOKEN_SHAPE = 'a Claim token is { requires: [<check ids>] } or { stop: true, comment?: <file> }';
// A Claim token in its form, its values as declared until resolved.ts types them.
export type CheckedClaimToken =
  { requires: unknown[]; stop?: never } | { stop: true; comment?: unknown; requires?: never };

// A stop token, or one requiring Checks of this Procedure; either way the form the Resolved Flow carries.
function checkClaimToken(problems: report.Report, token: unknown, checkIds: unknown[], location: string) {
  if (!referencePaths.isRecord(token)) {
    report.error(problems, location, 'malformed-claim-token', CLAIM_TOKEN_SHAPE);
    return { requires: [] };
  }
  const keysOf = (forms: string[]) => Object.keys(token).every((key) => forms.includes(key));
  if (token.stop === true && keysOf(CLAIM_TOKEN_FORMS.stop)) {
    if (token.comment !== undefined && !report.isName(token.comment))
      report.error(problems, location, 'file-not-named', 'comment must name a file', { key: 'comment' });
  } else if (Array.isArray(token.requires) && keysOf(CLAIM_TOKEN_FORMS.requires)) {
    for (const id of token.requires) {
      if (!checkIds.includes(id))
        report.error(
          problems,
          location,
          'undeclared-check',
          `requires ${JSON.stringify(id)}, which is not a Check of this Procedure`,
          { check: id },
        );
    }
  } else {
    report.error(problems, location, 'malformed-claim-token', CLAIM_TOKEN_SHAPE);
  }
  if (token.stop === true)
    return { stop: true as const, ...(token.comment !== undefined && { comment: token.comment }) };
  return { requires: Array.isArray(token.requires) ? token.requires : [] };
}

// What a Procedure's Claim tokens are checked against: where they sit, the Procedure as declared, its Actions so far,
// and its Checks' ids.
interface TokenContext {
  location: string;
  declaration: Value;
  declared: actionChecks.DeclaredSoFar;
  checkIds: string[];
}

export function checkClaimTokens(problems: report.Report, { location, declaration, declared, checkIds }: TokenContext) {
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
    return { ok: { requires: checkIds } };
  }
  const declaredTokens = declaration.claimTokens;
  // A present value that is not an object says so, rather than read as though the key were left out (#301).
  if (declaredTokens !== undefined && !referencePaths.isRecord(declaredTokens)) {
    const message = `claimTokens must be an object from token to form, not ${JSON.stringify(declaredTokens)}`;
    report.error(problems, `${location}.claimTokens`, 'not-an-object', message, { value: declaredTokens });
    return {};
  }
  if (!referencePaths.isRecord(declaredTokens) || !Object.keys(declaredTokens).length) {
    const message = 'a Procedure with an agent Action declares its claimTokens';
    report.error(problems, `${location}.claimTokens`, 'claim-tokens-missing', message);
    return {};
  }
  const claimTokens: [string, CheckedClaimToken][] = [];
  for (const [token, form] of Object.entries(declaredTokens)) {
    const atToken = `${location}.claimTokens.${token}`;
    report.checkName(problems, atToken, token, { what: 'Claim token', carried: false });
    report.checkReserved(problems, atToken, 'Claim token', token);
    claimTokens.push([token, checkClaimToken(problems, form, checkIds, atToken)]);
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
  return Object.fromEntries(claimTokens);
}
