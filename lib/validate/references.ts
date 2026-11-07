// A Procedure's reference paths and Rule Table fields typed in a scope: alone, with `inputs` of any type, and at each
// Vertex, with that Vertex's inputs. A table whose fields all type is analysed (rules.ts).

import * as procedures from '../procedures.ts';
import * as referencePaths from '../reference-paths.ts';
import * as rules from '../rules.ts';
import * as conditions from './conditions.ts';
import * as checked from './procedures.ts';
import * as report from './report.ts';

const STATES = ['passed', 'failed', 'not-run'];
const RULE_KINDS = ['enum', 'boolean', 'integer'];

// A reference that does not type, at `where` in the Procedure.
export interface Found extends report.Finding {
  where: string;
  path: unknown;
}
// A table whose every field typed: its fields and rows, for the analysis.
interface Typed {
  fields: rules.FieldMap;
  rows: rules.RuleRow[];
}
// What a typing reads of where it runs: the scope of `inputs`, and whether an input is optional.
interface Typing {
  inputs: referencePaths.SchemaNode;
  optional: (input: string) => boolean;
}
interface Reference {
  where: string;
  path: unknown;
  scope: referencePaths.SchemaNode;
}
// Why a typed reference cannot be read as its parameter needs, or null.
type Want = (type: referencePaths.FieldType, node: referencePaths.SchemaNode, path: unknown) => report.Finding | null;

// What a Visit reads of itself: its own outputs by Action id and its `inputs` (record.visitScope), and the response.
export const ownScope = (proc: checked.CheckedProcedure, inputs: referencePaths.SchemaNode) => ({
  ...(proc.agent && { response: proc.schema }),
  inputs,
  ...Object.fromEntries(
    proc.actions
      .filter((action) => referencePaths.isRecord(action) && typeof action.id === 'string')
      .map((action) => [
        (action as procedures.Action).id,
        procedures.outputs(action as procedures.Action, proc.schema),
      ]),
  ),
});
// ...and the Claim token, the pass and each Check's state, as a reference reads them in `table`.
export function visitScopeSchema(
  proc: checked.CheckedProcedure,
  table: checked.TableName,
  inputs: referencePaths.SchemaNode,
) {
  const recoverMax = referencePaths.isRecord(proc.recover) ? proc.recover.max : undefined;
  return {
    claim: { type: 'string', enum: proc.tokens[table] },
    pass: { type: 'integer', min: 1, max: 1 + (report.isCount(recoverMax) ? recoverMax : 0) },
    check: procedures.object(
      Object.fromEntries(proc.checkIds.map((id) => [id as string, { type: 'string', enum: STATES }])),
    ),
    ...ownScope(proc, inputs),
  };
}

function typeReference(found: Found[], reference: Reference, want: Want) {
  const resolved = referencePaths.resolve(reference.scope, reference.path, 'defined', { read: true });
  const problem =
    resolved.error === undefined
      ? resolved.type && want(resolved.type, resolved.node, reference.path)
      : { code: resolved.code, message: resolved.error };
  if (problem) found.push({ where: reference.where, path: reference.path, ...problem });
  return resolved;
}

const stringList =
  (label: string): Want =>
  (type, _, path) =>
    type.kind === 'list' && (type as { of: referencePaths.FieldType | null }).of?.kind === 'string'
      ? null
      : {
          code: 'not-a-list-of-strings',
          message: `${label} must read a list of strings; ${JSON.stringify(path)} is ${JSON.stringify(type)}`,
        };
const anyType: Want = () => null;
const repeatList =
  (check: Record<string, unknown>): Want =>
  (type, node) => {
    if (!conditions.isObjectList(type))
      return {
        code: 'not-a-list-of-objects',
        message: `list must read a list of objects; ${JSON.stringify(check.list)} is ${JSON.stringify(type)}`,
      };
    const field = (Array.isArray(check.fields) ? check.fields : []).find(
      (name) => report.isName(name) && conditions.itemField(node.items, name).error,
    );
    return field === undefined
      ? null
      : { code: 'unknown-item-field', message: `fields: ${JSON.stringify(field)} is not a field of the list's items` };
  };

const leftOut = (found: Found[], where: string, message: string) =>
  found.push({ where, path: undefined, code: 'required-key-missing', message });

// `tests: named` and each Action's reference parameters, all read when the Visit passes.
function actionReferences(found: Found[], proc: checked.CheckedProcedure, scope: referencePaths.SchemaNode) {
  if (referencePaths.isRecord(proc.tests))
    typeReference(found, { where: 'tests', path: proc.tests.named, scope }, stringList('tests: named'));
  proc.actions.forEach((action, index) => {
    if (!referencePaths.isRecord(action)) return;
    const where = `actions[${index}]`;
    if (action.do === 'check' && action.kind === 'tests-fail') {
      if (action.testNames === undefined) leftOut(found, where, 'a tests-fail Check must name testNames');
      else typeReference(found, { where, path: action.testNames, scope }, stringList('testNames'));
    }
    if (action.do === 'check' && action.kind === 'repeat') {
      if (action.list === undefined) leftOut(found, where, 'a repeat Check must name its list');
      else typeReference(found, { where, path: action.list, scope }, repeatList(action));
    }
    if (action.do === 'pr-upsert') {
      for (const path of Object.values(referencePaths.isRecord(action.with) ? action.with : {}))
        typeReference(found, { where, path, scope }, anyType);
    }
  });
}

function validCondition(condition: unknown) {
  if (typeof condition === 'string' || typeof condition === 'boolean' || Number.isInteger(condition)) return true;
  return (
    referencePaths.isRecord(condition) &&
    Object.keys(condition).length > 0 &&
    Object.entries(condition).every(
      ([op, value]) => (procedures.OPERATORS as string[]).includes(op) && Number.isInteger(value),
    )
  );
}

// One rule field's domain, or null when its path or condition does not type.
function fieldOf(found: Found[], reference: Reference & { path: string }, condition: unknown, typing: Typing) {
  const { where, path } = reference;
  if (!validCondition(condition)) {
    const message =
      `condition on ${JSON.stringify(path)} must be a string, boolean or integer, ` +
      `or an object of ${procedures.OPERATORS.join(', ')} with integers`;
    found.push({ where, path, code: 'invalid-rule-condition', message });
    return null;
  }
  const { type, error } = typeReference(found, reference, (fieldType) =>
    RULE_KINDS.includes(fieldType.kind as string)
      ? null
      : {
          code: 'invalid-rule-field',
          message:
            `rule field ${JSON.stringify(path)} is ${JSON.stringify(fieldType)}; ` +
            'rules match only enum, boolean and integer fields',
        },
  );
  if (error || !type || !RULE_KINDS.includes(type.kind as string)) return null;
  const scalar = type.kind === 'boolean' ? 'boolean' : 'string';
  const fits =
    type.kind === 'integer'
      ? typeof condition !== 'string' && typeof condition !== 'boolean'
      : typeof condition === scalar;
  if (!fits) {
    const message =
      `condition ${JSON.stringify(condition)} on ${JSON.stringify(path)} ` +
      `does not fit its field, which is ${JSON.stringify(type)}`;
    found.push({ where, path, code: 'rule-condition-mismatch', message });
    return null;
  }
  // An absent optional input is a value of the domain (T10).
  const steps = referencePaths.parse(path).steps as string[];
  return { ...type, ...(steps[0] === 'inputs' && typing.optional(steps[1]) && { absent: true }) } as rules.FieldSpec;
}

// A table's fields, and whether every row's every field typed.
function tableFields(found: Found[], proc: checked.CheckedProcedure, table: checked.TableName, typing: Typing) {
  const fields: rules.FieldMap = {};
  let typed = !proc.malformed.has(table);
  const scope = procedures.object(visitScopeSchema(proc, table, typing.inputs));
  proc.tables[table].forEach((row, index) => {
    if (!referencePaths.isRecord(row) || !referencePaths.isRecord(row.when)) return;
    for (const [path, condition] of Object.entries(row.when)) {
      const field = fieldOf(found, { where: `${table}[${index}]`, path, scope }, condition, typing);
      if (field) fields[path] = field;
      else typed = false;
    }
  });
  return { fields, typed };
}

// Every typed reference of a Procedure, given a scope for `inputs`, and each table whose fields all type.
export function typeReferences(proc: checked.CheckedProcedure, typing: Typing) {
  const found: Found[] = [];
  actionReferences(found, proc, procedures.object(visitScopeSchema(proc, 'passed', typing.inputs)));
  const falls: Partial<Record<checked.TableName, Typed>> = {};
  for (const table of checked.TABLES) {
    const { fields, typed } = tableFields(found, proc, table, typing);
    if (typed && proc.tokens[table].length) falls[table] = { fields, rows: proc.tables[table] as rules.RuleRow[] };
  }
  return { found, falls };
}

// A table's domain is the union of one box per Claim token reaching it, with that token's required Checks fixed:
// passed in the passed table; in the failed table, one box per required Check, where it is the first not to pass
// (R8b, J16).
function boxesOf(proc: checked.CheckedProcedure, table: checked.TableName) {
  return proc.tokens[table].flatMap((token) => {
    const requiredIds = checked.requiredCheckIds(proc, token);
    if (table === 'passed') return [{ token, checks: Object.fromEntries(requiredIds.map((id) => [id, ['passed']])) }];
    if (table === 'stopped') return [{ token, checks: {} as Record<string, string[]> }];
    return requiredIds.map((id, j) => ({
      token,
      checks: Object.fromEntries([
        ...requiredIds.slice(0, j).map((earlier) => [earlier, ['passed']]),
        [id, ['failed', 'not-run']],
      ]),
    }));
  });
}

function analyseTable(proc: checked.CheckedProcedure, table: checked.TableName, { fields, rows }: Typed) {
  const boxes = boxesOf(proc, table);
  const analysis = rules.analyse({
    name: `${proc.name}.${table}`,
    rows,
    boxes: boxes.map(({ token, checks }) =>
      Object.fromEntries(
        Object.entries(fields).map(([path, spec]) => {
          const [head, id] = referencePaths.parse(path).steps as string[];
          if (head === 'claim') return [path, { kind: 'enum', values: [token] }];
          return [path, head === 'check' && Object.hasOwn(checks, id) ? { kind: 'enum', values: checks[id] } : spec];
        }),
      ),
    ),
  });
  return {
    errors: analysis.errors,
    warnings: analysis.warnings,
    falls: report.unique(analysis.falls.map((box) => boxes[box].token)),
  };
}

const isInputPath = (path: unknown) => typeof path === 'string' && referencePaths.parse(path).steps?.[0] === 'inputs';

// Where a typing runs: alone (`atVertex` false) it reports everything but the references to `inputs` and the tables
// that read one, which each Vertex using the Procedure reports in its own scope. `locate` gives a finding's location.
export interface ReferenceContext extends Typing {
  atVertex: boolean;
  locate: (where: string) => string;
}

// A Procedure's typed references, typed alone or at a Vertex; the tokens some input falls through each table for.
export function checkReferences(problems: report.Report, proc: checked.CheckedProcedure, run: ReferenceContext) {
  const { found, falls } = typeReferences(proc, run);
  for (const finding of found)
    if (run.atVertex === isInputPath(finding.path))
      report.error(problems, run.locate(finding.where), finding.code, finding.message);
  const result: Partial<Record<checked.TableName, string[]>> = {};
  for (const [table, typed] of Object.entries(falls) as [checked.TableName, Typed][]) {
    if (run.atVertex !== Object.keys(typed.fields).some(isInputPath)) continue;
    const analysis = analyseTable(proc, table, typed);
    for (const { code, message } of analysis.errors) report.error(problems, run.locate(table), code, message);
    for (const { code, message } of analysis.warnings) report.warn(problems, run.locate(table), code, message);
    result[table] = analysis.falls;
  }
  return result;
}
