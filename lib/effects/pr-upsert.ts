// The pr-upsert Effect: the Ticket branch's PR, created or its body replaced, the body carrying its Action Marker.
import * as config from '../config.ts';
import type * as github from '../github.ts';
import type * as record from '../record.ts';
import * as effects from './index.ts';

export type Payload = { branch: string; base?: string; title: string; body: string; bodyHash: string };

// The gh verb a PR is upserted with (lib/github.ts); the PR's number is kept on the record.
export interface Context {
  record: Pick<record.ExecutionRecord, 'pr'>;
  gh: Pick<github.Gh, 'upsertPr'>;
  cwd?: string;
}

const perform: effects.Effect<Payload, Context>['perform'] = async ({ record: executionRecord, gh, cwd }, planned) => {
  const pr = await gh.upsertPr(planned as Parameters<typeof gh.upsertPr>[0], cwd);
  executionRecord.pr = pr.number;
  return { number: pr.number, url: pr.url };
};

// A PR whose body was edited since is upserted again, so a finder never conflicts.
const find: effects.FindEffect = async ({ actionMarker, payload }, { executionRecord, gh, cwd }) => {
  const { branch, bodyHash } = payload as Payload;
  const listed = await gh!.findPr(branch, cwd);
  if (!listed) return effects.ABSENT;
  const pr = await gh!.viewPr(listed.number, cwd);
  if (!effects.carries(pr.body, actionMarker) || config.sha256(pr.body) !== bodyHash) return effects.ABSENT;
  executionRecord.pr = pr.number;
  return effects.found({ number: pr.number, url: pr.url });
};

export const effect: effects.Effect<Payload, Context> = { name: 'pr-upsert', remote: 'GitHub', perform, find };
