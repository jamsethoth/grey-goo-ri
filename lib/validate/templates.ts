// Each name a template of a Procedure reads, checked in the scope it renders in (Y20, L2, R13e): a Brief, a recovery
// frame, a PR body, a comment and a stop's comment, each at a Vertex, with `inputs` its inputs.

import * as procedures from '../procedures.ts';
import * as referencePaths from '../reference-paths.ts';
import * as render from '../render.ts';
import type * as checked from './procedures.ts';
import * as references from './references.ts';
import * as report from './report.ts';

// What a template may name of gg's own context (Y20): a Brief's Ticket, base branch, commands, History, diff and
// changed test files; a recovery frame's sections and each section's Check; a public template's Ticket, provenance,
// Agent and marker. A History entry or provenance row is untyped, so a name inside a section over one is not checked.
const ANY_LIST = { type: 'array', items: referencePaths.ANY };
const TICKET = procedures.object({
  number: procedures.INTEGER,
  title: procedures.STRING,
  body: procedures.STRING,
  branch: procedures.STRING,
});
const BRIEF = {
  ticket: TICKET,
  baseBranch: procedures.STRING,
  commands: { type: 'array', items: procedures.object({ name: procedures.STRING, command: procedures.STRING }) },
  history: ANY_LIST,
  diff: procedures.STRING,
  changedTestFiles: procedures.STRING_LIST,
};
const SECTION = {
  id: procedures.STRING,
  kind: procedures.STRING,
  command: procedures.STRING,
  output: procedures.STRING,
  reason: procedures.STRING,
  failure: referencePaths.ANY,
  recoverable: { type: 'boolean' },
};
const AGENT = procedures.object({
  harness: procedures.STRING,
  model: procedures.STRING,
  effort: procedures.STRING,
  persona: procedures.STRING,
  personaHash: procedures.STRING,
});
const STOP = {
  end: procedures.STRING,
  outcome: procedures.STRING,
  reason: procedures.STRING,
  marker: procedures.STRING,
};

// A parsed template: strings, names, sections over a name and fences (render.parseTemplate).
interface TemplateTag {
  name: string;
  fence?: unknown;
  inverted?: boolean;
  children?: TemplateNode[];
}
type TemplateNode = string | TemplateTag;
type Template = { nodes: TemplateNode[]; error?: undefined } | { error: string; nodes?: undefined };
export type TemplateReader = (name: string) => Template;
type Scope = Record<string, referencePaths.SchemaNode>;

// Each template read and parsed once, however many Vertices render it; none when no reader is given.
export function templateReader(readTemplate: ((name: string) => string) | undefined): TemplateReader | null {
  if (!readTemplate) return null;
  const templates = new Map<string, Template>();
  return (name) => {
    if (!templates.has(name)) {
      try {
        templates.set(name, { nodes: render.parseTemplate(readTemplate(name)) as TemplateNode[] });
      } catch (err) {
        templates.set(name, { error: `${name} cannot be read: ${(err as Error).message}` });
      }
    }
    return templates.get(name) as Template;
  };
}

function lookup(node: referencePaths.SchemaNode, name: string): referencePaths.Resolved {
  const resolved = referencePaths.resolve(node, name, 'defined', { read: true });
  if (resolved.error === undefined || resolved.list === undefined) return resolved;
  return { ...resolved, error: `${resolved.error}; read its items in a section, {{#${resolved.list}}}` };
}

// A name reads the innermost section item that holds its first segment, then the scope (render.renderTemplate); an item
// of unknown shape may hold any name. A path is typed as rendering reads it.
function nodeOf(
  problems: report.Finding[],
  tag: TemplateTag,
  items: referencePaths.SchemaNode[],
  scope: referencePaths.SchemaNode,
) {
  if (tag.name === '.') return items[0] ?? referencePaths.ANY;
  const head = referencePaths.parse(tag.name).steps?.[0] as string;
  const item = items.find(
    (shape) =>
      shape === referencePaths.ANY ||
      (shape.type === 'object' && referencePaths.isRecord(shape.properties) && Object.hasOwn(shape.properties, head)),
  );
  if (item === referencePaths.ANY) return referencePaths.ANY;
  const resolved = lookup(item ?? scope, tag.name);
  if (resolved.error) problems.push(report.unresolved(resolved, tag.name, `{{${tag.name}}}: ${resolved.error}`));
  return resolved.node ?? referencePaths.ANY;
}

function walk(
  problems: report.Finding[],
  nodes: TemplateNode[],
  items: referencePaths.SchemaNode[],
  scope: referencePaths.SchemaNode,
) {
  for (const tag of nodes) {
    if (typeof tag === 'string') continue;
    if (tag.fence) {
      walk(problems, tag.children as TemplateNode[], items, scope);
      continue;
    }
    const node = nodeOf(problems, tag, items, scope);
    // A section renders once per list item, or once with its value; an inverted one keeps the scope it is in.
    const inner = node.type === 'array' ? (node.items as referencePaths.SchemaNode) : node;
    if (tag.children) walk(problems, tag.children, tag.inverted ? items : [inner, ...items], scope);
  }
}

// The problems of a template's names in `scope`.
function templateProblems(nodes: TemplateNode[], scope: referencePaths.SchemaNode) {
  const problems: report.Finding[] = [];
  walk(problems, nodes, [], scope);
  return [...new Map(problems.map((problem) => [problem.message, problem])).values()];
}

interface Reading {
  reader: TemplateReader;
  found: (report.Finding & { where: string })[];
}
// One template a Procedure names, at `where` under its `key`, checked in `scope`.
function readTemplate(reading: Reading, place: { where: string; key: string }, name: unknown, scope: Scope) {
  if (!report.isName(name)) return;
  const template = reading.reader(name);
  const problems: report.Finding[] = template.nodes
    ? templateProblems(template.nodes, procedures.object(scope))
    : [{ code: 'template-unreadable', message: template.error, params: { template: name } }];
  for (const problem of problems) {
    const message = `${place.key} ${name}: ${problem.message}`;
    reading.found.push({
      ...problem,
      where: place.where,
      message,
      params: { ...problem.params, template: name },
    } as report.Finding & { where: string });
  }
}

// A PR body reads the Visit, each `with` name bound to the node its path reads, the Ticket and the provenance.
function prBodyScope(action: Record<string, unknown>, visitScope: Scope): Scope {
  const bound = Object.fromEntries(
    Object.entries(referencePaths.isRecord(action.with) ? action.with : {}).map(([key, path]) => [
      key,
      referencePaths.resolve(procedures.object(visitScope), path, 'defined', { read: true }).node ?? referencePaths.ANY,
    ]),
  );
  return { ...visitScope, ...bound, ticket: TICKET, provenance: ANY_LIST, marker: procedures.STRING };
}

function actionTemplates(reading: Reading, proc: checked.CheckedProcedure, visitScope: Scope) {
  const brief = { ...visitScope, ...BRIEF };
  proc.actions.forEach((action, index) => {
    if (!referencePaths.isRecord(action)) return;
    const where = `actions[${index}]`;
    if (action.do === 'agent') readTemplate(reading, { where, key: 'brief' }, action.brief, brief);
    if (action.do === 'check')
      readTemplate(reading, { where, key: 'recoverBrief' }, action.recoverBrief, { ...brief, ...SECTION });
    if (action.do === 'pr-upsert')
      readTemplate(reading, { where, key: 'body' }, action.body, prBodyScope(action, visitScope));
    if (action.do === 'comment') {
      const scope = { ...visitScope, ...(proc.agent && { agent: AGENT }), marker: procedures.STRING };
      readTemplate(reading, { where, key: 'body' }, action.body, scope);
    }
  });
}

// Each name every template of the Procedure reads, in a Vertex's scope (`inputs` its inputs).
export function templateReferences(
  proc: checked.CheckedProcedure,
  inputs: referencePaths.SchemaNode,
  reader: TemplateReader | null,
) {
  if (!reader) return [];
  const reading: Reading = { reader, found: [] };
  const visitScope: Scope = references.visitScopeSchema(proc, 'passed', inputs);
  actionTemplates(reading, proc, visitScope);
  if (referencePaths.isRecord(proc.recover)) {
    const scope = { ...visitScope, ...BRIEF, sections: procedures.STRING_LIST };
    readTemplate(reading, { where: 'recover', key: 'brief' }, proc.recover.brief, scope);
  }
  for (const [token, claimToken] of Object.entries(proc.claimTokens)) {
    if (claimToken.stop) {
      const scope = { ...references.ownScope(proc, inputs), ...STOP };
      readTemplate(reading, { where: `claimTokens.${token}`, key: 'comment' }, claimToken.comment, scope);
    }
  }
  return reading.found;
}
