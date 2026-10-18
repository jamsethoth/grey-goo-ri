import { markerTrailer, markerComment } from './marker.mjs';
import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

// Errors, agent prose and Check output can all contain local directories; redact before hashing public bodies.
export function publicText(text, directories = []) {
  const boundary = /(?<![\p{L}\p{N}_./\\~-])/.source;
  const start = /(?<!\[local\])(?:file:\/\/\/?)?/.source;
  // A percent escape after the directory continues its last name, as a letter does.
  const end = /(?![\p{L}\p{N}_~-]|\.[\p{L}\p{N}_-]|%[0-9a-fA-F]{2})/.source;
  const paths = [...directories, homedir(), tmpdir(), fileURLToPath(new URL('../', import.meta.url))]
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
    // Short roots need boundaries; longer roots also occur inside flags such as -I/home/alice/inc.
    const directory = path.split('/').map((part) => [...part].map(pathChar).join('')).join(/[\\/]+/.source);
    const pattern = (single ? boundary : '') + start + directory + end;
    text = text.replace(new RegExp(pattern, windows || process.platform === 'win32' ? 'giu' : 'gu'), '[local]');
  }
  return text;
}

// File URLs, encodeURI and encodeURIComponent each escape a different set of characters, so any character an encoder
// may escape also matches its UTF-8 percent escape in either hex case; an escaped separator (%2F) is not matched.
// shortcut: Windows 8.3 aliases are not resolved; add native short-path lookup when these diagnostics must be supported.
function pathChar(c) {
  const literal = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (/[\w.~-]/.test(c)) return literal;
  const escaped = [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).padStart(2, '0')}`).join('');
  return `(?:${literal}|${escaped.replace(/[a-f]/g, (h) => `[${h}${h.toUpperCase()}]`)})`;
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
export function fence(s, redact = publicText) {
  const text = publicTail(String(s ?? '').trim(), redact);
  // The fence outruns any backtick run in the text so agent text cannot close it early.
  const f = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)));
  return `${f}\n${text}\n${f}`;
}

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

export function commitMessage({ kind, title, ticket, summary, vertex, harness, model, effort, marker }, redact = publicText) {
  return `${kind}: ${redact(title)} (#${ticket})

${redact(summary)}

Feature-Flow-Stage: ${vertex} ${harness}/${model}/${effort}
${markerTrailer(marker)}
`;
}

export function prBody({ ticket, impl, provenance, marker }, redact = publicText) {
  const qa = impl.qa;
  return `Closes #${ticket.number}

## Summary
${redact(impl.summary)}

## Definition of done
${impl.dod.map((d) => `- [${d.met ? 'x' : ' '}] ${redact(d.item)}${d.evidence ? ` — ${redact(d.evidence)}` : ''}`).join('\n')}

## TDD evidence
**Red** (\`${redact(impl.red.command)}\`)
${fence(impl.red.output, redact)}
**Green** (\`${redact(impl.green.command)}\`)
${fence(impl.green.output, redact)}

## QA instructions
**Setup:** ${redact(qa.setup)}

${qa.steps.map((s, i) => `${i + 1}. ${redact(s.action)}\n   - Expected: ${redact(s.expected)}`).join('\n')}

**Edge cases to try**
${list(qa.edgeCases?.map((x) => redact(x)))}

**Covered by automated tests**
${list(qa.automated?.map((x) => redact(x)))}

**Needs human eyes**
${list(qa.manual?.map((x) => redact(x)))}

## Provenance
| Vertex | Harness | Model | Effort | Persona | Calls | Tokens in (cached) / out |
|---|---|---|---|---|---|---|
${provenance.map((p) => `| ${p.vertex} | ${p.harness} | ${p.model} | ${p.effort} | ${p.persona}@${p.hash} | ${p.calls} | ${p.input} (${p.cached}) / ${p.output} |`).join('\n')}

${markerComment(marker)}
`;
}

export function reviewComment(review, p, marker, redact = publicText) {
  return `### gg review: **${review.claim}**
_${p.harness} ${p.model} (${p.effort}), persona ${p.persona}@${p.hash}_

${fence(review.summary, redact)}

- Definition of done met: ${review.dodMet ? 'yes' : 'no'}
- TDD evidence OK: ${review.tddEvidenceOk ? 'yes' : 'no'}

${review.findings.length ? review.findings.map((f) => `**${f.severity}**\n${fence(f.file, redact)}\n${fence(f.issue, redact)}\nFix:\n${fence(f.fix, redact)}`).join('\n\n') : '_No findings._'}

VERDICT: ${review.claim}

${markerComment(marker)}
`;
}

export function blockedComment(response, marker, reason, redact = publicText) {
  return `### gg: blocked

${fence(response.summary, redact)}

${fence(response.notes, redact)}
${reason ? `\n**Terminal Reason:** ${redact(reason.text)}\n` : ''}
${markerComment(marker)}
`;
}

export function terminalComment(terminal, reason, marker, detail, interrupted, redact = publicText) {
  return `### gg: ${terminal}

**Terminal Reason:** ${redact(reason.text)}
${detail ? `\n${fence(detail, redact)}\n` : ''}${interrupted
  ? `\n**Interrupted:** the ${interrupted.terminal} Terminal, whose Terminal Reason was: ${redact(interrupted.reason.text)}\n` : ''}
${markerComment(marker)}
`;
}

export function diagnosisComment(response, marker, reason, redact = publicText) {
  return `### gg: replan

${fence(response.summary, redact)}

${fence(response.diagnosis, redact)}
${reason ? `\n**Terminal Reason:** ${redact(reason.text)}\n` : ''}
${markerComment(marker)}
`;
}
