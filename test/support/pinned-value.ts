// The value a case's Execution runs under (#369): its configuration pinned with its Flow, under the case's own Config
// Hash, which is the record's, so no Visit entry logs a change. The files, commands and test paths are the
// configuration's own objects, so a case's edit of them reaches the Execution.
import type * as config from '../../lib/config.ts';
import * as model from '../../lib/model.ts';

export interface Configured {
  files: config.SourceFiles;
  commands: config.PinnedConfiguration['commands'];
  testPaths: string[];
  approvers?: string[];
}

export const pinnedOf = (configured: Configured, flow: model.ResolvedFlow, hash: string): config.Pinned => ({
  configuration: {
    flow: model.toJson(flow),
    files: configured.files,
    harnesses: {},
    launchProfile: null,
    commands: configured.commands,
    testPaths: configured.testPaths,
    ...(configured.approvers && { approvers: configured.approvers }),
  },
  flow,
  hash,
});

// The value with another Flow in place of its own, as a later Run of a changed configuration pins it.
export const withFlow = (pinned: config.Pinned, flow: model.ResolvedFlow): config.Pinned => ({
  ...pinned,
  configuration: { ...pinned.configuration, flow: model.toJson(flow) },
  flow,
});
