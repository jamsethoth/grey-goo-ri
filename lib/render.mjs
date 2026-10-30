import { markerTrailer, markerComment, partsOf } from './marker.mjs';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical } from './paths.mjs';
import * as refs from './refs.mjs';

// The shipped Briefs and comments sit beside the shipped Personas; the Terminal Reason comment is gg's own (R11a).
const SHIPPED = new URL('../defaults/templates/', import.meta.url);
const ENGINE = new URL('./templates/', import.meta.url);
// shortcut: a template name is an absolute path or a shipped template; Layer templates arrive with #116.
export const templateFile = (name, dir = SHIPPED) => readFileSync(isAbsolute(name) ? name : new URL(name, dir), 'utf8');

const TAG = /\{\{([#^/]?)\s*([^}]*?)\s*\}\}/g;

// A Markdown fence, found by line as Markdown finds it: a run of three or more backticks or tildes opens it (a backtick
// fence's info string holds no backtick), and the first later line holding only a run of as many of that character closes
// it. The template renders what the fence holds and fences it again past the runs in it (fenceOf).
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/gm;
function fences(text) {
  const marks = [];
  let open = null;
  for (const m of text.matchAll(FENCE)) {
    const [line, run, rest] = m;
    const index = m.index + line.indexOf(run);
    if (!open && !(run[0] === '`' && rest.includes('`'))) {
      open = { char: run[0], ticks: run.length };
      marks.push({ index, end: index + run.length, fence: open });
    } else if (open && run[0] === open.char && run.length >= open.ticks && /^[ \t]*\r?$/.test(rest)) {
      marks.push({ index, end: index + run.length + rest.match(/^[ \t]*/)[0].length });
      open = null;
    }
  }
  return marks;
}

// A section tag alone on its line takes the whole line with it, as in Mustache, so a template reads like its output.
function parseTemplate(text) {
  const root = { children: [] };
  const open = [root];
  let at = 0;
  const marks = [...[...text.matchAll(TAG)].map((m) => ({ index: m.index, m })), ...fences(text)].sort((a, b) => a.index - b.index);
  for (const mark of marks) {
    const node = open.at(-1);
    if (!mark.m) {
      node.children.push(text.slice(at, mark.index));
      at = mark.end;
      if (mark.fence) {
        const fence = { fence: mark.fence, children: [] };
        node.children.push(fence);
        open.push(fence);
      } else if (node.fence) open.pop();
      else throw new Error(`{{${node.inverted ? '^' : '#'}${node.name}}} must close inside the fence it opens in`);
      continue;
    }
    const [tag, sigil, name] = mark.m;
    let start = mark.index;
    let end = start + tag.length;
    if (sigil) {
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const newline = text.indexOf('\n', end);
      const lineEnd = newline < 0 ? text.length : newline + 1;
      if (/^[ \t]*$/.test(text.slice(lineStart, start)) && /^[ \t]*\r?\n?$/.test(text.slice(end, lineEnd))) [start, end] = [lineStart, lineEnd];
    }
    node.children.push(text.slice(at, start));
    at = end;
    if (!sigil) node.children.push({ name });
    else if (sigil === '/') {
      if (open.length === 1 || node.name !== name) throw new Error(`{{/${name}}} closes no open section`);
      open.pop();
    } else {
      const section = { name, inverted: sigil === '^', children: [] };
      node.children.push(section);
      open.push(section);
    }
  }
  const unclosed = open.at(-1);
  if (unclosed.fence) throw new Error('a fence is not closed');
  if (unclosed !== root) throw new Error(`{{${unclosed.inverted ? '^' : '#'}${unclosed.name}}} is not closed`);
  root.children.push(text.slice(at));
  return root.children;
}

const empty = (v) => !v || (Array.isArray(v) && !v.length);
const isObject = (v) => typeof v === 'object' && v !== null;

// The Mustache subset of #105: {{name}}, {{#name}}…{{/name}} once per list item or once when present, {{^name}}…{{/name}}
// when absent or empty, and {{.}} for the current item; no escaping, partials or helpers. A context value may be a
// function, called (and awaited) only when the template names it, and at most once. Values keep their types for lookup
// and sections; `emit` formats each value the template prints, given its node and whether one of the template's fences
// holds it.
export async function template(text, context, emit = (v) => v ?? '') {
  const nodes = parseTemplate(text);
  const computed = new Map();
  const top = (key) => {
    if (!Object.hasOwn(context, key)) return undefined;
    if (!computed.has(key)) computed.set(key, typeof context[key] === 'function' ? context[key]() : context[key]);
    return computed.get(key);
  };
  // A name reads the innermost section value that holds its first segment, then the context.
  const lookup = async (name, scopes) => {
    if (name === '.') return scopes[0];
    const { steps, error } = refs.parse(name);
    if (error) throw new Error(`{{${name}}}: ${error}`);
    const scope = scopes.find((s) => isObject(s) && Object.hasOwn(s, steps[0]));
    return refs.read(scope ?? { [steps[0]]: await top(steps[0]) }, name);
  };
  const walk = async (list, scopes, fenced = false) => {
    let out = '';
    for (const node of list) {
      if (typeof node === 'string') out += node;
      else if (node.fence) out += fenceOf(await walk(node.children, scopes, true), node.fence);
      else if (!node.children) out += emit(await lookup(node.name, scopes), node, fenced);
      else {
        const v = await lookup(node.name, scopes);
        if (node.inverted) out += empty(v) ? await walk(node.children, scopes, fenced) : '';
        else if (!empty(v)) for (const item of Array.isArray(v) ? v : [v]) out += await walk(node.children, [item, ...scopes], fenced);
      }
    }
    return out;
  };
  return walk(nodes, []);
}

// Errors, agent prose and Check output can all contain local directories; redact before hashing public bodies.
export function publicText(text, directories = []) {
  // Configuration such as an unset model or effort arrives as null and renders as it always has.
  text = String(text);
  const boundary = /(?<![\p{L}\p{N}_./\\~-])/.source;
  const start = /(?<!\[local\])(?:file:\/\/\/?)?/.source;
  // A percent escape after the directory continues its last name, as a letter does.
  const end = /(?![\p{L}\p{N}_~-]|\.[\p{L}\p{N}_-]|%[0-9a-fA-F]{2})/.source;
  // git and tools report canonical paths while gg was handed linked or 8.3 spellings, so both forms are masked.
  const paths = [...directories, homedir(), tmpdir(), fileURLToPath(new URL('../', import.meta.url))]
    .flatMap((p) => (p && isAbsolute(p) ? [p, canonical(p)] : [p]))
    .map((p) => p?.replaceAll('\\', '/').replace(/^\/\/\?\/UNC\//i, '//').replace(/^\/\/\?\//, '').replace(/\/+$/, ''))
    .filter((p) => p && p.length > 3 && p !== posix.parse(p).root && p !== win32.parse(p).root)
    .flatMap((p) => {
      const windows = /^(?:[a-z]:\/|\/\/)/i.test(p);
      const aliases = [p];
      if (/^[a-z]:\//i.test(p)) aliases.push(`/?/${p}`, `/${p[0]}${p.slice(2)}`);
      if (p.startsWith('//')) aliases.push(`//?/UNC/${p.slice(2)}`, `file:${p}`);
      if (p.startsWith('/var/')) aliases.push(`/private${p}`);
      return aliases.map((path) => ({ path, windows, single: /^\/[^/]+$/.test(p) }));
    })
    .sort((a, b) => b.path.length - a.path.length);
  for (const { path, windows, single } of paths) {
    const folded = windows || process.platform === 'win32';
    // Short roots need boundaries; longer roots also occur inside flags such as -I/home/alice/inc.
    const directory = path.split('/').map((part) => [...part].map((c) => pathChar(c, folded)).join('')).join(/[\\/]+/.source);
    const pattern = (single ? boundary : '') + start + directory + end;
    text = text.replace(new RegExp(pattern, folded ? 'giu' : 'gu'), '[local]');
  }
  return text;
}

// File URLs, encodeURI and encodeURIComponent each escape a different set of characters, so any character an encoder
// may escape also matches its UTF-8 percent escape in either hex case; an escaped separator (%2F) is not matched.
// The case-insensitive flag folds literal letters only, so a folded match also takes the escapes of the other case.
// shortcut: an 8.3 alias is masked only when gg was given it; a known long path does not also mask its alias.
function pathChar(c, folded) {
  const literal = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // pathToFileURL escapes ~, which 8.3 names such as RUNNER~1 contain.
  if (/[\w.-]/.test(c)) return literal;
  const forms = folded ? [...new Set([c, c.toLowerCase(), c.toUpperCase()])] : [c];
  const escaped = forms.map((form) => [...new TextEncoder().encode(form)].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('')
    .replace(/[a-f]/g, (h) => `[${h}${h.toUpperCase()}]`));
  return `(?:${[literal, ...escaped].join('|')})`;
}

export const publicTextFor = ({ worktree, commonDir, cwd }) => (text) => publicText(text, [worktree, commonDir, cwd]);

export function publicTail(s, redact = publicText, limit = 3000) {
  const text = redact(String(s ?? ''));
  const cut = text.length - limit;
  if (cut <= 0) return text;
  // A newline that ends the text has no line after it to keep, so the tail falls back to characters.
  const newline = text.indexOf('\n', cut - 1);
  return newline >= 0 && newline < text.length - 1 ? text.slice(newline + 1) : text.slice(-limit);
}

export const list = (xs, prefix = '- ') => (xs?.length ? xs.map((x) => `${prefix}${x}`).join('\n') : '_none_');
// `held` is what the fence holds, its info string first. The fence outruns any run of its character in it so agent text
// cannot close it early; an info string that came to hold a backtick takes a tilde fence, which Markdown allows it.
function fenceOf(held, { char, ticks }) {
  const c = char === '`' && held.split('\n', 1)[0].includes('`') ? '~' : char;
  const f = c.repeat(Math.max(ticks, ...(held.match(c === '`' ? /`+/g : /~+/g) ?? []).map((r) => r.length + 1)));
  return `${f}${held}${f}`;
}
export const fence = (s, redact = publicText) => fenceOf(`\n${publicTail(String(s ?? '').trim(), redact)}\n`, { char: '`', ticks: 3 });

export function ticketBody(t, epic) {
  return `Part of #${epic}.

## Goal
${t.goal}

## In scope
${list(t.inScope)}

## Out of scope
${list(t.outOfScope)}

## Definition of done
${list(t.dod, '- [ ] ')}

## Tests to write first
${list(t.tests)}

## QA hints
${list(t.qaHints)}
`;
}

export function epicBody(plan) {
  return `${plan.summary}\n\nTickets are sub-issues of this epic. Run with \`gg run <this issue number>\`.\n`;
}

// Configuration such as a model or persona name is public text too; only the Action Marker is never redacted.
export function commitMessage({ kind, title, ticket, summary, vertex, harness, model, effort, marker }, redact = publicText) {
  return `${redact(kind)}: ${redact(title)} (#${ticket})

${redact(summary)}

Feature-Flow-Stage: ${redact(vertex)} ${redact(harness)}/${redact(model)}/${redact(effort)}
${markerTrailer(marker)}
`;
}

// One row per Vertex. Each agent Attempt is one call counted by its own usage.delta, so the tokens of a Session it resumed
// are not counted again.
export function provenance(rec) {
  const rows = {};
  for (const e of rec.log) {
    if (e.step !== 'evidence' || e.action !== 'call') continue;
    const { vertex, visit, action } = partsOf(e.marker);
    const s = rec.sessions[`${vertex}/${visit}/${action}`];
    const row = rows[vertex] ??= { vertex, harness: s.harness, model: s.model, effort: s.effort, persona: s.persona,
      hash: s.personaHash.slice(0, 12), calls: 0, input: 0, cached: 0, output: 0 };
    row.calls++;
    row.input += e.evidence.usage.input;
    row.cached += e.evidence.usage.cached;
    row.output += e.evidence.usage.output;
  }
  return Object.values(rows);
}

// A public template's values are redacted once as each is emitted, and fenced past their own backticks where the template
// fences them, so no template can publish a local path. The Action Marker line is gg's own and is never redacted.
export function publicBody(name, context, marker, redact = publicText) {
  const line = markerComment(marker);
  return template(templateFile(name), { ...context, marker: line }, (v, node, fenced) => {
    if (v === undefined) return '';
    if (v === line) return v;
    return fenced ? publicTail(String(v).trim(), redact) : redact(String(v));
  });
}

export function terminalComment(terminal, reason, marker, detail, interrupted, redact = publicText) {
  return template(templateFile('terminal.md', ENGINE), {
    end: redact(terminal), reason: redact(reason.text), detail: detail ? fence(detail, redact) : '',
    interrupted: interrupted && { end: redact(interrupted.terminal), reason: redact(interrupted.reason.text) },
    marker: markerComment(marker),
  });
}
