import { markerTrailer, markerComment } from './marker.mjs';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

// Errors, agent prose and Check output can all contain local directories; redact before hashing public bodies.
export function publicText(text, directories = []) {
  const paths = [...directories, homedir(), tmpdir(), fileURLToPath(new URL('../', import.meta.url))]
    .filter(Boolean).flatMap((p) => [p, p.replaceAll('\\', '/'), p.replaceAll('\\', '\\\\')])
    .sort((a, b) => b.length - a.length);
  for (const path of new Set(paths)) {
    text = text.replace(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), process.platform === 'win32' ? 'gi' : 'g'), '[local]');
  }
  return text;
}

export const list = (xs, prefix = '- ') => (xs?.length ? xs.map((x) => `${prefix}${x}`).join('\n') : '_none_');
export function fence(s) {
  const text = String(s ?? '').trim().slice(-3000);
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

export function prBody({ ticket, impl, provenance, marker }) {
  const qa = impl.qa;
  return `Closes #${ticket.number}

## Summary
${impl.summary}

## Definition of done
${impl.dod.map((d) => `- [${d.met ? 'x' : ' '}] ${d.item}${d.evidence ? ` — ${d.evidence}` : ''}`).join('\n')}

## TDD evidence
**Red** (\`${impl.red.command}\`)
${fence(impl.red.output)}
**Green** (\`${impl.green.command}\`)
${fence(impl.green.output)}

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

export function reviewComment(review, p, marker) {
  return `### gg review: **${review.claim}**
_${p.harness} ${p.model} (${p.effort}), persona ${p.persona}@${p.hash}_

${fence(review.summary)}

- Definition of done met: ${review.dodMet ? 'yes' : 'no'}
- TDD evidence OK: ${review.tddEvidenceOk ? 'yes' : 'no'}

${review.findings.length ? review.findings.map((f) => `**${f.severity}**\n${fence(f.file)}\n${fence(f.issue)}\nFix:\n${fence(f.fix)}`).join('\n\n') : '_No findings._'}

VERDICT: ${review.claim}

${markerComment(marker)}
`;
}

export function blockedComment(response, marker, reason) {
  return `### gg: blocked

${fence(response.summary)}

${fence(response.notes)}
${reason ? `\n**Terminal Reason:** ${reason.text}\n` : ''}
${markerComment(marker)}
`;
}

export function terminalComment(terminal, reason, marker, detail, interrupted) {
  return `### gg: ${terminal}

**Terminal Reason:** ${reason.text}
${detail ? `\n${fence(detail)}\n` : ''}${interrupted
  ? `\n**Interrupted:** the ${interrupted.terminal} Terminal, whose Terminal Reason was: ${interrupted.reason.text}\n` : ''}
${markerComment(marker)}
`;
}

export function diagnosisComment(response, marker, reason) {
  return `### gg: replan

${fence(response.summary)}

${fence(response.diagnosis)}
${reason ? `\n**Terminal Reason:** ${reason.text}\n` : ''}
${markerComment(marker)}
`;
}
