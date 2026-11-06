import { readFileSync } from 'node:fs';
import * as marker from './marker.ts';
import * as publicText from './public-text.ts';
import type * as record from './record.ts';
import * as referencePaths from './reference-paths.ts';

// gg's own templates, which no Layer declares: the Terminal Reason comment (R11a), the parse-retry nudge and a recovery
// section for a Check with no recoverBrief (T4b). Every other template is a Layer file.
const ENGINE = new URL('./templates/', import.meta.url);
export const engineTemplate = (name: string): string => readFileSync(new URL(name, ENGINE), 'utf8');

const TAG = /\{\{([#^/]?)\s*([^}]*?)\s*\}\}/g;

// A fence's character and the length of the run that opened it.
interface FenceOpening {
  char: string;
  ticks: number;
}
// A parsed template: strings, names, sections over a name, and fences.
export interface TemplateName {
  name: string;
}
export interface TemplateSection {
  name: string;
  inverted: boolean;
  children: TemplateNode[];
}
export interface TemplateFence {
  fence: FenceOpening;
  children: TemplateNode[];
}
export type TemplateNode = string | TemplateName | TemplateSection | TemplateFence;
type Container = { children: TemplateNode[] } & Partial<TemplateSection> & Partial<TemplateFence>;
// Where a fence line's run starts and ends; an opening line carries its fence.
interface FenceMark {
  index: number;
  end: number;
  fence?: FenceOpening;
  tag?: undefined;
}
// Where a tag starts, and its match.
interface TagMark {
  index: number;
  tag: RegExpExecArray;
}

// A Markdown fence, found by line as Markdown finds it: a run of three or more backticks or tildes opens it (a backtick
// fence's info string holds no backtick), and the first later line holding only a run of as many of that character
// closes it. The template renders what the fence holds and fences it again past the runs in it (fenceOf).
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/gm;
function fences(text: string): FenceMark[] {
  const marks: FenceMark[] = [];
  let open: FenceOpening | null = null;
  for (const match of text.matchAll(FENCE)) {
    const [line, run, rest] = match;
    const index = match.index + line.indexOf(run);
    if (!open && !(run[0] === '`' && rest.includes('`'))) {
      open = { char: run[0], ticks: run.length };
      marks.push({ index, end: index + run.length, fence: open });
    } else if (open && run[0] === open.char && run.length >= open.ticks && /^[ \t]*\r?$/.test(rest)) {
      marks.push({ index, end: index + run.length + rest.match(/^[ \t]*/)![0].length });
      open = null;
    }
  }
  return marks;
}

// A section tag alone on its line takes the whole line with it, as in Mustache, so a template reads like its output.
function tagSpan(text: string, { index, tag: [tag, sigil] }: TagMark): [number, number] {
  const end = index + tag.length;
  if (!sigil) return [index, end];
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  const newline = text.indexOf('\n', end);
  const lineEnd = newline < 0 ? text.length : newline + 1;
  if (/^[ \t]*$/.test(text.slice(lineStart, index)) && /^[ \t]*\r?\n?$/.test(text.slice(end, lineEnd)))
    return [lineStart, lineEnd];
  return [index, end];
}

// A fence line opens a fence, or closes the one open.
function fenceLine(mark: FenceMark, open: Container[]) {
  const node = open.at(-1)!;
  if (mark.fence) {
    const fence: TemplateFence = { fence: mark.fence, children: [] };
    node.children.push(fence);
    open.push(fence);
  } else if (node.fence) open.pop();
  else throw new Error(`{{${node.inverted ? '^' : '#'}${node.name}}} must close inside the fence it opens in`);
}

// The tree is strings, { name }, sections { name, inverted, children } and fences { fence, children }.
export function parseTemplate(text: string): TemplateNode[] {
  const root: Container = { children: [] };
  const open: Container[] = [root];
  let offset = 0;
  const marks: (FenceMark | TagMark)[] = [
    ...[...text.matchAll(TAG)].map((tag) => ({ index: tag.index, tag })),
    ...fences(text),
  ].sort((first, second) => first.index - second.index);
  for (const mark of marks) {
    const node = open.at(-1)!;
    if (!mark.tag) {
      node.children.push(text.slice(offset, mark.index));
      offset = mark.end;
      fenceLine(mark, open);
      continue;
    }
    const [, sigil, name] = mark.tag;
    const [start, end] = tagSpan(text, mark);
    node.children.push(text.slice(offset, start));
    offset = end;
    if (!sigil) node.children.push({ name });
    else if (sigil === '/') {
      if (open.length === 1 || node.name !== name) throw new Error(`{{/${name}}} closes no open section`);
      open.pop();
    } else {
      const section: TemplateSection = { name, inverted: sigil === '^', children: [] };
      node.children.push(section);
      open.push(section);
    }
  }
  const unclosed = open.at(-1)!;
  if (unclosed.fence) throw new Error('a fence is not closed');
  if (unclosed !== root) throw new Error(`{{${unclosed.inverted ? '^' : '#'}${unclosed.name}}} is not closed`);
  root.children.push(text.slice(offset));
  return root.children;
}

const empty = (value: unknown) => !value || (Array.isArray(value) && !value.length);

// How a template prints a value: given the value, its node, whether one of the template's fences holds it, and whether
// a section item, not the context, held its name.
export type Emit = (value: unknown, node: TemplateName, fenced: boolean, item: boolean) => unknown;

// The Mustache subset of #105: {{name}}, {{#name}}…{{/name}} once per list item or once when present,
// {{^name}}…{{/name}} when absent or empty, and {{.}} for the current item; no escaping, partials or helpers. A context
// value may be a function, called (and awaited) only when the template names it, and at most once. Values keep their
// types for lookup and sections; `emit` formats each value the template prints.
export async function renderTemplate(
  text: string,
  context: Record<string, unknown>,
  emit: Emit = (value) => value ?? '',
): Promise<string> {
  const nodes = parseTemplate(text);
  const computed = new Map<string, unknown>();
  const top = (key: string) => {
    if (!Object.hasOwn(context, key)) return undefined;
    // Called as the context's method, as a template's caller wrote it.
    if (!computed.has(key))
      computed.set(key, typeof context[key] === 'function' ? (context[key] as () => unknown)() : context[key]);
    return computed.get(key);
  };
  // A name reads the innermost section value that holds its first segment, then the context.
  const lookup = async (name: string, scopes: unknown[]) => {
    if (name === '.') return { value: scopes[0], item: true };
    const { steps, error } = referencePaths.parse(name);
    if (error) throw new Error(`{{${name}}}: ${error}`);
    const scope = scopes.find((candidate) => referencePaths.isRecord(candidate) && Object.hasOwn(candidate, steps![0]));
    return { value: referencePaths.read(scope ?? { [steps![0]]: await top(steps![0]) }, name), item: !!scope };
  };
  const walk = async (list: TemplateNode[], scopes: unknown[], fenced = false): Promise<string> => {
    let rendered = '';
    for (const node of list) {
      if (typeof node === 'string') rendered += node;
      else if ('fence' in node) rendered += fenceOf(await walk(node.children, scopes, true), node.fence);
      else if (!('children' in node)) {
        const { value, item } = await lookup(node.name, scopes);
        rendered += emit(value, node, fenced, item) as string;
      } else {
        const { value } = await lookup(node.name, scopes);
        if (node.inverted) rendered += empty(value) ? await walk(node.children, scopes, fenced) : '';
        else if (!empty(value))
          for (const item of Array.isArray(value) ? value : [value])
            rendered += await walk(node.children, [item, ...scopes], fenced);
      }
    }
    return rendered;
  };
  return walk(nodes, []);
}

export const list = (items: unknown[] | null | undefined, prefix = '- '): string =>
  items?.length ? items.map((item) => `${prefix}${item}`).join('\n') : '_none_';
// `held` is what the fence holds, its info string first. The fence outruns any run of its character in it so agent text
// cannot close it early; an info string that came to hold a backtick takes a tilde fence, which Markdown allows it.
function fenceOf(held: string, { char, ticks }: FenceOpening): string {
  const used = char === '`' && held.split('\n', 1)[0].includes('`') ? '~' : char;
  const runs = (held.match(used === '`' ? /`+/g : /~+/g) ?? []).map((run) => run.length + 1);
  const fence = used.repeat(Math.max(ticks, ...runs));
  return `${fence}${held}${fence}`;
}
export const fence = (given: unknown, redact: publicText.Redact = publicText.publicText): string =>
  fenceOf(`\n${publicText.publicTail(String(given ?? '').trim(), redact)}\n`, { char: '`', ticks: 3 });

// A Ticket a Plan publishes.
export interface PlannedTicket {
  goal: string;
  inScope?: unknown[];
  outOfScope?: unknown[];
  dod?: unknown[];
  tests?: unknown[];
  qaHints?: unknown[];
}

export function ticketBody(ticket: PlannedTicket, epic: number): string {
  return `Part of #${epic}.

## Goal
${ticket.goal}

## In scope
${list(ticket.inScope)}

## Out of scope
${list(ticket.outOfScope)}

## Definition of done
${list(ticket.dod, '- [ ] ')}

## Tests to write first
${list(ticket.tests)}

## QA hints
${list(ticket.qaHints)}
`;
}

export function epicBody(plan: { summary: string }): string {
  return `${plan.summary}\n\nTickets are sub-issues of this epic. Run with \`gg run <this issue number>\`.\n`;
}

// What a commit message names: the Action's kind, the Ticket, the agent's summary, and the Vertex and Agent that made
// it.
export interface CommitFields {
  kind: unknown;
  title: unknown;
  ticket: number;
  summary: unknown;
  vertex: unknown;
  harness: unknown;
  model: unknown;
  effort: unknown;
  marker: string;
}

// Configuration such as a model or persona name is public text too; only the Action Marker is never redacted. An unset
// model or effort arrives as null, which publicText prints as it always has.
export function commitMessage(
  { kind, title, ticket, summary, vertex, harness, model, effort, marker: actionMarker }: CommitFields,
  redact: publicText.Redact = publicText.publicText,
): string {
  const shown = (value: unknown) => redact(value as string);
  return `${shown(kind)}: ${shown(title)} (#${ticket})

${shown(summary)}

Gg-Vertex: ${shown(vertex)} ${shown(harness)}/${shown(model)}/${shown(effort)}
${marker.markerTrailer(actionMarker)}
`;
}

// One provenance row: a Vertex's Agent and Persona, and the calls and tokens its Attempts spent.
export interface ProvenanceRow {
  vertex: string;
  harness: string;
  model: string | null;
  effort: string | null;
  persona: string;
  personaHash: string;
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

// One row per Vertex. Each agent Attempt is one call counted by its own usage.delta, so the tokens of a Session it
// resumed are not counted again.
export function provenance(executionRecord: record.ExecutionRecord): ProvenanceRow[] {
  const rows: Record<string, ProvenanceRow> = {};
  for (const entry of executionRecord.writeAheadLog) {
    if (entry.step !== 'evidence' || entry.effect !== 'call') continue;
    const { vertex, visit, action } = marker.partsOf(entry.actionMarker);
    const session = executionRecord.sessions[`${vertex}/${visit}/${action}`];
    const row = (rows[vertex] ??= {
      vertex,
      harness: session.harness,
      model: session.model,
      effort: session.effort,
      persona: session.personaName,
      personaHash: session.personaHash.slice(0, 12),
      calls: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      outputTokens: 0,
    });
    const usage = entry.evidence!.usageDelta as Record<'inputTokens' | 'cacheReadTokens' | 'outputTokens', number>;
    row.calls++;
    row.inputTokens += usage.inputTokens;
    row.cacheReadTokens += usage.cacheReadTokens;
    row.outputTokens += usage.outputTokens;
  }
  return Object.values(rows);
}

// A public template's values are redacted once as each is emitted, and fenced past their own backticks where the
// template fences them, so no template can publish a local path. The Action Marker line is gg's own and is never
// redacted.
export function publicBody(
  text: string,
  context: Record<string, unknown>,
  actionMarker: string,
  redact: publicText.Redact = publicText.publicText,
): Promise<string> {
  const line = marker.markerComment(actionMarker);
  return renderTemplate(text, { ...context, marker: line }, (value, _node, fenced) => {
    if (value === undefined) return '';
    if (value === line) return value;
    return fenced ? publicText.publicTail(String(value).trim(), redact) : redact(String(value));
  });
}

// What a Terminal's comment reports: its end state and Terminal Reason, the Action Marker, the fault's detail, and the
// Terminal an earlier Run reached but did not finish reporting.
export interface TerminalCommentFields {
  end: string;
  reason: { text: string };
  marker: string;
  detail?: string | null;
  interrupted?: { terminal: string; terminalReason: { text: string } } | null;
  redact?: publicText.Redact;
}

export function terminalComment({
  end,
  reason,
  marker: actionMarker,
  detail,
  interrupted,
  redact = publicText.publicText,
}: TerminalCommentFields): Promise<string> {
  return renderTemplate(engineTemplate('terminal.md'), {
    end: redact(end),
    reason: redact(reason.text),
    detail: detail ? fence(detail, redact) : '',
    interrupted: interrupted && { end: redact(interrupted.terminal), reason: redact(interrupted.terminalReason.text) },
    marker: marker.markerComment(actionMarker),
  });
}
