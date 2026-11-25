// What scripts/record-codex.ts launches every call on, its model and schema, and the Codex Harness's own launch a
// scenario may run under instead of the recorder's (#481 Q1 A): its launchArgs for a read-only Agent on that model
// listing the scenario's plugins, over the listings it reads of the home, with the skills list it gives written before
// the prompt, as #482's run writes it before the Brief.
import { writeFileSync } from 'node:fs';
import * as containment from '../lib/containment.ts';
import * as exec from '../lib/exec.ts';
import * as cliDoctor from '../lib/harnesses/cli-doctor.ts';
import * as codex from '../lib/harnesses/codex.ts';
import type { Scenario } from './record-codex-scenarios.ts';

// The cheapest model the catalog lists ("Fast and affordable model for easier tasks"), at its lowest effort.
export const MODEL = 'gpt-6-luna';
export const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};

export interface Launched {
  argv: string[];
  prompt: string;
  lastMessage: string;
}

// The Harness's launch of a scenario that asks for it, or undefined.
export async function launched(
  scenario: Scenario,
  home: string,
  directories: { repo: string; run: string },
): Promise<Launched | undefined> {
  if (scenario.harness === undefined) return undefined;
  const runner = exec.createExec({ kernel32: containment.openKernel32() });
  // `codex plugin list` reads the remote catalog and once took 87 s, past the cheap wall limit validate lists under.
  const listings = await codex.list(
    { launch: (launch) => runner.launch({ ...launch, wallMs: cliDoctor.PROBE_WALL_MS }) },
    home,
  );
  const agent = { harness: 'codex', persona: 'recorder.md', model: MODEL, effort: 'low', ...scenario.harness };
  const call = {
    marker: 'gg-recording',
    agent,
    schema: SCHEMA,
    cwd: directories.repo,
    resume: null,
    runDirectory: directories.run,
    access: 'read-only',
  };
  const launch = codex.createCodex({ codexHome: home }).launchArgs(call, codex.resolveTools(agent), listings);
  for (const [path, text] of Object.entries(launch.files)) writeFileSync(path, text);
  return { argv: launch.argv, prompt: `${launch.skills}\n${scenario.prompt}`, lastMessage: launch.lastMessage };
}
