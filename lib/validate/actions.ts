// Each Action of a Procedure checked in order: its id, its kind and that kind's keys, and the order the Actions run in.

import * as briefs from '../briefs.ts';
import * as procedures from '../procedures.ts';
import * as referencePaths from '../reference-paths.ts';
import * as report from './report.ts';

// The heads of gg's own reference paths, so an Action id never shadows one.
const HEADS = ['claim', 'pass', 'check', 'response', 'inputs', 'rescue'];

type Value = Record<string, unknown>;
// A schema read once, however many Procedures name it; one that cannot be used types as ANY and reports its error.
export interface LoadedSchema {
  node: referencePaths.SchemaNode;
  error?: report.Finding;
}
// What checking a Procedure reads beyond the Procedure itself.
export interface ProcedureContext {
  report: report.Report;
  readSchema: (name: string) => unknown;
  schemas: Map<string, LoadedSchema>;
  commands: unknown;
}

// What the Actions so far have declared, as each Action is checked in order.
export interface DeclaredSoFar {
  ids: unknown[];
  agent: Value | null;
  schema: referencePaths.SchemaNode;
  schemaName: string | null;
  checks: Value[];
  responseConditions: [Value, string][];
}

function loadSchema(declaring: ProcedureContext, name: string, location: string) {
  const { schemas } = declaring;
  if (!schemas.has(name)) schemas.set(name, readSchema(declaring.readSchema, name));
  const loaded = schemas.get(name) as LoadedSchema;
  if (loaded.error) report.error(declaring.report, location, loaded.error.code, loaded.error.message);
  return loaded.node;
}
function readSchema(read: ProcedureContext['readSchema'], name: string): LoadedSchema {
  let schema;
  try {
    schema = read(name);
  } catch (err) {
    const message = `schema ${name} cannot be read: ${(err as Error).message}`;
    return { node: referencePaths.ANY, error: { code: 'schema-unreadable', message } };
  }
  try {
    briefs.assertStrict(schema);
    return { node: schema as referencePaths.SchemaNode };
  } catch (err) {
    const message = `${name}: ${(err as Error).message}`;
    return { node: referencePaths.ANY, error: { code: 'schema-not-strict', message } };
  }
}

const requireFile = (problems: report.Report, action: Value, key: string, location: string) => {
  if (!report.isName(action[key])) report.error(problems, location, 'file-not-named', `${key} must name a file`);
};

// One sentence states three rules, and the code says which one the value breaks.
function requireNames(problems: report.Report, names: unknown, location: string, message: string) {
  if (!Array.isArray(names)) report.error(problems, location, report.absentOr(names, 'not-a-list'), message);
  else if (!names.length) report.error(problems, location, 'empty-list', message);
  else if (!names.every(report.isName)) report.error(problems, location, 'invalid-name', message);
}

// How a sentence names an Action with its id left out. A present null is a wrong value, which it quotes.
const actionLabel = (id: unknown) => (id === undefined ? 'with no id' : id);

function checkActionId(problems: report.Report, ids: unknown[], id: unknown, location: string) {
  if (id === undefined) {
    report.error(problems, location, 'required-key-missing', 'an Action must have an id');
    return;
  }
  if (!report.checkName(problems, location, id, { what: 'Action id', carried: true })) return;
  if (ids.includes(id))
    report.error(problems, location, 'repeated-action-id', `Action id ${JSON.stringify(id)} is repeated`);
  else if (HEADS.includes(id))
    report.error(
      problems,
      location,
      'reserved-name',
      `Action id ${JSON.stringify(id)} is reserved for gg's references: ${HEADS.join(', ')}`,
    );
}

function checkAction(declaring: ProcedureContext, declared: DeclaredSoFar, action: unknown, location: string) {
  const problems = declaring.report;
  if (!referencePaths.isRecord(action))
    return report.error(problems, location, 'not-an-object', 'an Action must be an object');
  checkActionId(problems, declared.ids, action.id, location);
  declared.ids.push(action.id);
  if (action.do === undefined)
    return report.error(problems, location, 'required-key-missing', 'an Action must name its kind in do');
  const kinds = Object.keys(procedures.ACTION_KEYS).join(', ');
  if (!report.hasOwnKey(procedures.ACTION_KEYS, action.do))
    return report.error(
      problems,
      location,
      'unknown-action-kind',
      `do ${JSON.stringify(action.do)} is not one of ${kinds}`,
    );
  const isCheck = action.do === 'check';
  if (isCheck && !report.hasOwnKey(procedures.CHECK_KEYS, action.kind)) {
    declared.checks.push(action);
    if (action.kind === undefined)
      return report.error(problems, location, 'required-key-missing', 'a Check must name its kind');
    const checkKinds = Object.keys(procedures.CHECK_KEYS).join(', ');
    return report.error(
      problems,
      location,
      'unknown-check-kind',
      `Check kind ${JSON.stringify(action.kind)} is not one of ${checkKinds}`,
    );
  }
  const checkKeys = isCheck ? procedures.CHECK_KEYS[action.kind as procedures.CheckKind] : [];
  report.unknownKeys(problems, action, ['id', 'do', ...procedures.ACTION_KEYS[action.do], ...checkKeys], location);
  if (action.do === 'agent') checkAgentAction(declaring, declared, action, location);
  else if (isCheck) checkCheckAction(declaring, declared, action, location);
  else checkEffectAction(problems, action, location);
}

function checkAgentAction(declaring: ProcedureContext, declared: DeclaredSoFar, action: Value, location: string) {
  const problems = declaring.report;
  if (declared.agent)
    return report.error(problems, location, 'second-agent-action', 'a Procedure has at most one agent Action');
  declared.agent = action;
  requireFile(problems, action, 'brief', location);
  if (report.isName(action.schema)) {
    declared.schemaName = action.schema;
    declared.schema = loadSchema(declaring, action.schema, location);
  } else requireFile(problems, action, 'schema', location);
}

function checkCheckAction(declaring: ProcedureContext, declared: DeclaredSoFar, check: Value, location: string) {
  const problems = declaring.report;
  declared.checks.push(check);
  if (check.recoverBrief !== undefined) requireFile(problems, check, 'recoverBrief', location);
  if (check.recoverable !== undefined && typeof check.recoverable !== 'boolean')
    report.error(problems, location, 'not-a-boolean', 'recoverable must be true or false');
  // A Check names a Declared Command, never a command line (U13).
  if (
    (check.kind === 'command' || check.kind === 'tests-fail') &&
    !report.hasOwnKey(declaring.commands, check.command)
  ) {
    const command = JSON.stringify(check.command);
    if (check.command === undefined)
      report.error(problems, location, 'required-key-missing', `Check ${actionLabel(check.id)} must name a command`);
    else
      report.error(
        problems,
        location,
        'undeclared-command',
        `Check ${actionLabel(check.id)} names command ${command}, which the repository Layer does not declare`,
      );
  }
  if (check.kind === 'command' && check.reuse !== undefined && check.reuse !== 'tree')
    report.error(problems, location, 'invalid-reuse', 'reuse may only be tree');
  if (check.kind === 'response') declared.responseConditions.push([check, location]);
  if (check.kind === 'repeat')
    requireNames(problems, check.fields, location, 'fields must be a non-empty list of field names');
}

function checkEffectAction(problems: report.Report, action: Value, location: string) {
  if (action.do === 'commit') {
    if (!report.isName(action.type))
      report.error(problems, location, 'commit-type-unnamed', 'type must name the commit type');
  } else if (action.do === 'pr-upsert') {
    requireFile(problems, action, 'body', location);
    if (action.with !== undefined && !referencePaths.isRecord(action.with))
      report.error(problems, location, 'not-an-object', 'with must be an object of reference paths');
  } else if (action.do === 'comment') {
    if (action.target !== 'pr' && action.target !== 'ticket')
      report.error(
        problems,
        location,
        report.absentOr(action.target, 'invalid-comment-target'),
        'target must be pr or ticket',
      );
    requireFile(problems, action, 'body', location);
  } else if (action.do === 'await-approval') {
    // The decisions' own rules are #119's.
    requireNames(problems, action.decisions, location, 'decisions must be a non-empty list of names');
  }
}

// The Actions in order, and what they declared between them.
export function checkActions(declaring: ProcedureContext, actions: unknown[], location: string) {
  const declared: DeclaredSoFar = {
    ids: [],
    agent: null,
    schema: referencePaths.ANY,
    schemaName: null,
    checks: [],
    responseConditions: [],
  };
  actions.forEach((action, index) => checkAction(declaring, declared, action, `${location}.actions[${index}]`));
  return declared;
}

// A pass is the agent Action and the Checks after it (T4, R1a), decided at its last Check: the agent Action comes first
// and every Check before any effect, so a commit or pr-ready counts only Checks that ran (Q3a) and no effect runs for a
// Visit that then stops or fails (Q3).
export function checkOrder(problems: report.Report, location: string, actions: unknown[]) {
  const agentAt = actions.findIndex((action) => referencePaths.isRecord(action) && action.do === 'agent');
  if (agentAt > 0) {
    report.error(
      problems,
      `${location}.actions[${agentAt}]`,
      'agent-action-not-first',
      'the agent Action comes first, so a recovery pass runs every Check again after it',
    );
  }
  const effect = actions.find(
    (action) =>
      referencePaths.isRecord(action) &&
      report.hasOwnKey(procedures.ACTION_KEYS, action.do) &&
      action.do !== 'agent' &&
      action.do !== 'check',
  ) as Value | undefined;
  if (!effect) return;
  const effectAt = actions.indexOf(effect);
  actions.forEach((action, index) => {
    if (referencePaths.isRecord(action) && action.do === 'check' && index > effectAt) {
      report.error(
        problems,
        `${location}.actions[${index}]`,
        'check-after-effect',
        `Check ${actionLabel(action.id)} comes after ${effect.do} Action ${actionLabel(effect.id)}; ` +
          'every Check comes before any effect, so no effect runs before its pass is decided',
      );
    }
  });
}
