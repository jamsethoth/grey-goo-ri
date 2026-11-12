// stub (#362): the configuration verdict gg doctor and gg run share.
import type * as config from './config.ts';
import type * as report from './validate/report.ts';

export type SourceName = 'repository' | 'user';

export interface DeclaredFlow {
  json: Record<string, unknown>;
  declaredName: string;
  source: SourceName;
  files: config.SourceFiles;
}

export interface CheckOptions {
  config: config.Configuration;
  harnesses: Record<string, unknown>;
  commonDir?: string;
}

export interface Verdict {
  flows: Map<string, DeclaredFlow>;
  configurationErrors: report.Problem[];
  environmentErrors: report.Problem[];
  goneFlowRecords: report.Problem[];
  warnings: report.Problem[];
  misfits: Map<string, report.Problem>;
  settings?: config.Settings;
}

export async function check(_options: CheckOptions): Promise<Verdict> {
  return {
    flows: new Map(),
    configurationErrors: [],
    environmentErrors: [],
    goneFlowRecords: [],
    warnings: [],
    misfits: new Map(),
  };
}
