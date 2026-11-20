// An agent's hand-off past its contextBudget (#430): the Claim and note gg adds to a budgeted Agent's schema, the note
// and Session the next Attempt takes over in a fresh Session, the handed-off Sessions kept on the record, and the
// command that asks one. Only lib/agent-action.ts imports it.
import * as briefs from './briefs.ts';
import type * as marker from './marker.ts';
import type * as record from './record.ts';
import type * as referencePaths from './reference-paths.ts';
import * as render from './render.ts';
import type { HarnessResult } from './run-context.ts';
import type * as visit from './visit.ts';
import * as visitScope from './visit-scope.ts';

// The note and Session an Attempt takes over from when the Attempt before it handed off.
export interface Handoff {
  note: string;
  sessionId: string | null;
}

// An Agent with a contextBudget may hand off past it, by gg's own Claim token and note (Q3 A).
export const schemaOf = (agent: visit.ConfigurationSnapshot['agent'], declared: referencePaths.SchemaNode) =>
  agent?.contextBudget == null ? declared : briefs.handoffSchema(declared);

// What the next Attempt takes over when the one before handed off: the note its valid response left in its Action's
// outputs, and its Session; null after any other row.
export function handoffOf(
  executionRecord: record.ExecutionRecord,
  actionIdentity: marker.ActionIdentity,
  previous: { row?: visit.Resolution['row']; sessionId?: string | null },
): Handoff | null {
  if (previous.row !== 'handed-off') return null;
  const response = visitScope.outputOf(executionRecord, actionIdentity)?.value.response as Record<string, unknown>;
  return { note: String(response[briefs.HANDOFF_NOTE]), sessionId: previous.sessionId ?? null };
}

// The Brief after a hand-off: the Attempt's own, then gg's hand-off section with the note.
export async function withSection(text: string, handoff: Handoff | null | undefined): Promise<string> {
  if (!handoff) return text;
  const section = await briefs.brief(render.engineTemplate('handoff.md'), { ...handoff });
  return `${text.trimEnd()}\n\n${section}`;
}

// Once the Action has handed a Session off, its agent may ask it through gg ask-session (Q1 A).
export const askable = (session: record.SessionEntry | undefined, commands: Record<string, string>) =>
  session?.handedOff?.some((handedOff) => handedOff.sessionId)
    ? { ...commands, 'ask-session': 'gg ask-session' }
    : commands;

// The Sessions an Action handed off, oldest first, with this call's when it handed off: kept on the record beside the
// fresh Session, so its successor may ask one (Q4 A).
export function kept(
  session: record.SessionEntry | undefined,
  { row, attempt }: { row: visit.Resolution['row']; attempt: number },
  result: HarnessResult,
): Pick<record.SessionEntry, 'handedOff'> {
  const handedOff = [...(session?.handedOff ?? [])];
  if (row === 'handed-off')
    handedOff.push({
      sessionId: result.sessionId,
      transcriptPath: result.transcriptPath,
      cumulativeUsage: result.usage.cumulative,
      attempt,
    });
  return handedOff.length ? { handedOff } : {};
}
