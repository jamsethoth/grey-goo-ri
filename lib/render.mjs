import { markerTrailer, markerComment } from './marker.mjs';
import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

// Errors, agent prose and Check output can all contain local directories; redact before hashing public bodies.
export function publicText(text, directories = []) {
  const boundary = /(?<![\p{L}\p{N}_./\\~-])/.source;
  const start = /(?<!\[local\])(?:file:\/\/\/?)?/.source;
  const end = /(?![\p{L}\p{N}_~-]|\.[\p{L}\p{N}_-])/.source;
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
    const directory = path.split('/').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(/[\\/]+/.source);
    const pattern = (single ? boundary : '') + start + directory + end;
    text = text.replace(new RegExp(pattern, windows || process.platform === 'win32' ? 'giu' : 'gu'), '[local]');
  }
  return text;
}

export const publicTextFor = ({ worktree, commonDir, cwd }) => (text) => publicText(text, [worktree, commonDir, cwd]);

export function publicTail(s, redact = publicText, limit = 3000) {
  const text = redact(String(s ?? ''));
  const cut = text.length - limit;
  if (cut <= 0) return text;
  const newline = text.indexOf('\n', cut - 1);
  return newline < 0 ? text.slice(-limit) : text.slice(newline + 1);
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

export function commitMessage({ kind, title, ticket, summary, vertex, harness, model, effort, marker }) {
  return `${kind}: ${title} (#${ticket})

${summary}

Feature-Flow-Stage: ${vertex} ${harness}/${model}/${effort}
${markerTrailer(marker)}
`;
}

export function prBody({ ticket, impl, provenance, marker }, redact = publicText) {
  const qa = impl.qa;
  return `Closes #${ticket.number}

## Summary
${impl.summary}

## Definition of done
${impl.dod.map((d) => `- [${d.met ? 'x' : ' '}] ${d.item}${d.evidence ? ` — ${d.evidence}` : ''}`).join('\n')}

## TDD evidence
**Red** (\`${impl.red.command}\`)
${fence(impl.red.output, redact)}
**Green** (\`${impl.green.command}\`)
${fence(impl.green.output, redact)}

## QA instructions
**Setup:** ${qa.setup}

${qa.steps.map((s, i) => `${i + 1}. ${s.action}\n   - Expected: ${s.expected}`).join('\n')}

**Edge cases to try**
${list(qa.edgeCases)}

**Covered by automated tests**
${list(qa.automated)}

**Needs human eyes**
${list(qa.manual)}

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
${reason ? `\n**Terminal Reason:** ${reason.text}\n` : ''}
${markerComment(marker)}
`;
}

export function terminalComment(terminal, reason, marker, detail, interrupted, redact = publicText) {
  return `### gg: ${terminal}

**Terminal Reason:** ${reason.text}
${detail ? `\n${fence(detail, redact)}\n` : ''}${interrupted
  ? `\n**Interrupted:** the ${interrupted.terminal} Terminal, whose Terminal Reason was: ${interrupted.reason.text}\n` : ''}
${markerComment(marker)}
`;
}

export function diagnosisComment(response, marker, reason, redact = publicText) {
  return `### gg: replan

${fence(response.summary, redact)}

${fence(response.diagnosis, redact)}
${reason ? `\n**Terminal Reason:** ${reason.text}\n` : ''}
${markerComment(marker)}
`;
}
