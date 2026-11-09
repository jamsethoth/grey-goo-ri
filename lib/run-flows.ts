// The Flows a Run admits: the validator's Resolved Flows, each with its Pinned Configuration, the one `--flow` names,
// preflight over every declared Flow's Harnesses, and the Flow an Execution runs.
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as config from './config.ts';
import * as contract from './harnesses/contract.ts';
import * as model from './model.ts';
import * as report from './validate/report.ts';
import * as validator from './validate/index.ts';

// A declared Flow, its Pinned Configuration (the Flow with the files, Harnesses and commands it runs under) and that
// configuration's Config Hash.
export interface PinnedFlow {
  flow: model.ResolvedFlow;
  pinned: unknown;
  hash: string;
}

const withExitCode = (message: string, exitCode: number) => Object.assign(new Error(message), { exitCode });

// A Harness module as preflight checks it: the shipped modules declare only their paths until slices 2 and 3.
interface PreflightHarness {
  run?: unknown;
  validate(agent: unknown): Promise<{ ok: boolean; errors: string[] }>;
  resolveTools(agent: unknown): Promise<unknown>;
}

// Each Vertex's registered Harness, checked by name before any GitHub access.
async function harnessProblems(failed: report.Report, flow: model.ResolvedFlow, harnesses: Record<string, unknown>) {
  for (const [id, { agent }] of flow.ticket.vertices) {
    const harness =
      agent && typeof agent.harness === 'string' && Object.hasOwn(harnesses, agent.harness)
        ? (harnesses[agent.harness] as PreflightHarness)
        : null;
    // A Vertex without an Agent (publish) runs on no Harness; an unset or unregistered one is the validator's error.
    if (!harness) continue;
    try {
      // shortcut: the shipped Harness modules declare only their paths until slices 2 and 3; drop this when each
      // implements the contract.
      if (!harness.run) throw new Error('not implemented');
      contract.assertHarness(harness);
      const { ok, errors } = await harness.validate(agent);
      if (!ok) throw new Error(errors.join(', '));
      await harness.resolveTools(agent);
    } catch (err) {
      const reason = (err as Error).message.split('\n')[0];
      const harnessName = agent!.harness as string;
      const location = `flows.${flow.name}.ticket.vertices.${id}`;
      const message = `vertex ${id}: harness ${harnessName}: ${reason}`;
      report.error(failed, location, 'harness-preflight-failed', message, { vertex: id, harness: harnessName, reason });
    }
  }
}

// The configuration's errors, as gg doctor prints them (V1), and the registered Harness of every Vertex of every
// declared Flow, since a resumed Execution runs the Flow its record pins, all failures in one error. An unset Harness
// is a configuration gap, so any one makes the error exit 2.
async function preflight(
  flows: model.ResolvedFlow[],
  errors: report.Problem[],
  layers: config.Config,
  { harnesses, repoRoot }: { harnesses: Record<string, unknown>; repoRoot: string },
) {
  const problems = [...config.repositoryLayerProblems(layers, config.layerPath(repoRoot)), ...errors];
  const unset = errors.some((error) => error.code === 'harness-unset');
  const failedHarnesses = report.newReport();
  for (const flow of flows) await harnessProblems(failedHarnesses, flow, harnesses);
  problems.push(...failedHarnesses.errors);
  const failed = problems.map((problem) => report.line('error', problem));
  if (unset) {
    const examples = readdirSync(config.EXAMPLES_DIRECTORY)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => join(config.EXAMPLES_DIRECTORY, file));
    failed.push(`Merge one of ${examples.join(', ')} into the user Layer at ${config.layerPath(homedir())}.`);
  }
  if (failed.length) throw withExitCode(`preflight failed:\n${failed.join('\n')}`, unset ? 2 : 1);
}

// What gg run admits: the merged Layers, the registered Harnesses and the Flow `--flow` names.
interface Admitted {
  config: config.Configuration;
  harnesses: Record<string, unknown>;
  flow?: string;
}

// Admission runs the validator gg doctor runs, so gg run rejects exactly what gg doctor rejects (V1, ADR 0014). A new
// Execution runs the Flow `--flow` names, else default (X2), which must be declared.
export async function admitConfiguration(
  { config: configuration, harnesses, flow: flowName = 'default' }: Admitted,
  repoRoot: string,
) {
  const layers = config.merged(configuration);
  const validated = validator.validate(layers, {
    harnesses,
    readSchema: (name) => JSON.parse(config.layerFile(layers.files, name)),
    readTemplate: (name) => config.layerFile(layers.files, name),
  });
  const { errors, warnings } = validated;
  const flows = validated.flows as Record<string, unknown>;
  const declared = Object.keys(flows);
  if (declared.length && !Object.hasOwn(flows, flowName)) {
    const unknown = report.newReport();
    const message = `no Flow named ${flowName} is declared; the repository Layer declares ${declared.join(', ')}`;
    report.error(unknown, 'flows', 'unknown-flow', message, { name: flowName, declared });
    errors.push(...unknown.errors);
  }
  const commands = (layers.commands ?? {}) as Record<string, unknown>;
  // A Flow that is not an object resolves to nothing, and the validator reports it.
  const admitted = new Map<string, PinnedFlow>(
    Object.entries(flows)
      .filter(([, json]) => json !== undefined)
      .map(([name, json]) => {
        const pinned = {
          flow: json,
          files: layers.files,
          harnesses: layers.harnesses ?? {},
          launchProfile: null,
          commands,
          testPaths: layers.testPaths,
          approvers: layers.approvers,
        };
        return [name, { flow: model.fromJson(json), pinned, hash: config.configHash(pinned) }];
      }),
  );
  const resolved = [...admitted.values()].map(({ flow }) => flow);
  await preflight(resolved, errors, layers, { harnesses, repoRoot });
  return { flows: admitted, selected: admitted.get(flowName)!, warnings, commands };
}

// The Flow an Execution runs: the one its record pins, whatever `--flow` says (X2). Admission runs a record whose Flow
// is no longer declared only to finish a decided report, which runs no Vertex, so it runs under an empty Flow of that
// name and the Config Hash the caller gives, the record's own.
export function pinnedFlow(flows: ReadonlyMap<string, PinnedFlow>, name: string, hash: string): PinnedFlow {
  const ticket = { entry: null, vertices: new Map<string, model.Vertex>() };
  return flows.get(name) ?? { flow: { name, actionCap: 0, procedures: new Map(), ticket }, pinned: null, hash };
}
