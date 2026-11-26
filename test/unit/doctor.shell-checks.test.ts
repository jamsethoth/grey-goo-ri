// What every shipped Harness's doctor checks of the shell it starts the Agents' commands in on win32 (#533, ADR 0030
// decision 5): the containment probe, over each Harness's CLI answering in-process as recorded. Each Harness's own
// cases are in doctor.cli-checks.test.ts and doctor.codex-checks.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as shipped from '../../lib/harnesses/shipped.ts';
import type * as runContext from '../../lib/run-context.ts';
import * as caseEnv from '../support/case-env.ts';
import * as recordedCli from '../support/recorded-cli.ts';
import * as recordedCodexCli from '../support/recorded-codex-cli.ts';
import * as tempDirectory from '../support/temp-directory.ts';

// The Agents' shell is Windows' (ADR 0025), so its checks run on win32 alone.
const ON_WINDOWS = { skip: process.platform !== 'win32' && 'Windows only: the shell is checked on win32' };

// Each shipped Harness's CLI as recorded, by the name shipped gives it, the containment probe answered as recorded.
const RECORDED_CLIS: Record<string, () => ReturnType<typeof recordedCli.recordedCli>> = {
  claude: () => recordedCli.recordedCli(),
  codex: () => recordedCodexCli.recordedCodexCli(),
};

// What is wrong with Harness `name`'s doctor, cheap or under --probe: a containment probe without --probe, or under it
// other than one probe whose argv names `shell` and passes; null when nothing is.
async function wrongProbe(name: string, probe: boolean, shell: string): Promise<string | null> {
  const cli = RECORDED_CLIS[name]!();
  const harnessDoctor = shipped.shipped(cli)[name]!.doctor as (
    options: runContext.DoctorOptions,
  ) => Promise<runContext.DoctorReport>;
  const { checks } = await harnessDoctor({ probe, agents: {} });
  const argvs = cli.probes.map(({ command, args }) => [command, ...args]);
  const containment = checks.find((check) => check.name === 'containment-probe');
  const said = `${JSON.stringify(argvs)} ${containment?.message ?? 'no containment-probe check'}`;
  if (!probe) return argvs.length || containment ? `${name} without --probe: ${said}` : null;
  const ran = argvs.length === 1 && argvs[0]!.includes(shell) && containment?.ok === true;
  return ran ? null : `${name} under --probe: ${said}`;
}

// ADR 0030 decision 5, #533 DoD 2 and 3, Q1 B: every shipped Harness's doctor runs the containment probe in the first
// pwsh on PATH under --probe (Codex's through its sandbox), and none starts a command in its shell without --probe, as
// in gg doctor and preflight.
test(
  "every shipped Harness's doctor runs the containment probe in the first pwsh on PATH, under --probe alone",
  ON_WINDOWS,
  async (t) => {
    const directory = tempDirectory.tempDirectory(t, 'gg-doctor-shell-');
    const bin = join(directory, 'PowerShell', '7');
    mkdirSync(bin, { recursive: true });
    for (const file of ['pwsh.exe', 'gg.cmd']) writeFileSync(join(bin, file), '');
    caseEnv.caseEnv(t, { PATH: bin, GG_HOME: join(directory, 'gg-home') });
    assert.deepEqual(Object.keys(RECORDED_CLIS), Object.keys(shipped.HARNESSES));
    const wrong: string[] = [];
    for (const name of Object.keys(RECORDED_CLIS))
      for (const probe of [false, true]) wrong.push((await wrongProbe(name, probe, join(bin, 'pwsh.exe'))) ?? '');
    assert.deepEqual(wrong.filter(Boolean), []);
  },
);
