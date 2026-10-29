---
status: accepted
date: 2026-10-28
---

# The Windows job helper caches its compiled assembly beside itself

`lib/winjob.ps1` runs every `runShell` call that has a timeout on Windows, so every Check, and it compiled its C# job
code with `Add-Type -TypeDefinition` on each call: about 0.2 s of a warm call and about 1 s of a cold one on
`windows-2025` (grey-goo-ri issue #79). The helper now loads a compiled copy from `lib/winjob-cache/`, beside the
script in gg's install, and compiles only when no intact copy is there.

A copy's file name is `<source>-<content>.dll`: the SHA-256 of the C# source as the script holds it, then the SHA-256
of the file's own bytes. The helper looks only for its own source's name, reads the file once, checks the content hash
against those bytes and loads the same bytes with `Assembly.Load`, so the file cannot change between check and load. A
file whose bytes do not match its name is deleted. A copy from another version of the script has another name and is
never looked at. When nothing matches, the helper compiles to a temporary file in the cache, loads its bytes and
renames it into place. The compile is not deterministic, so helpers that start together on an empty cache each keep a
copy under its own name, and later calls load whichever intact one they find first. When the cache cannot be
written, a read-only install for example, the helper compiles in memory on every call, as it did before. A `loaded` or
`compiled` note on stderr says which happened; `lib/exec.mjs` ignores notes it does not know, so it did not change.

## Threat model

The helper runs the loaded code outside the sandbox of the agent whose Check it runs. An agent that could replace the
cached assembly could therefore run code outside its sandbox. The cache is safe for one reason only: it is in the same
directory as `winjob.ps1`, which the helper runs anyway. An agent that can write to that directory can already rewrite
the script, or `lib/exec.mjs` beside it. So the cache gives such an agent nothing new, and an agent that cannot write
there cannot plant an assembly. A hash file written beside the assembly would add nothing: whoever could rewrite one
could rewrite both. The content hash in the name detects damage, not tampering.

- A Codex `workspace-write` agent writes inside its sandbox's writable roots, such as its worktree and `%TEMP%`. None
  is searched: the cache path comes from the script's own location, never from the working directory, the
  environment or the command.
  `test/contract/exec/exec.test.mjs` plants an assembly, under the exact name of the real one, in a worktree and in
  `%TEMP%`, and checks that it is not loaded.
- A Claude agent on Windows runs in trusted-command mode (ADR 0007), which does not stop writes outside the checked
  worktrees. It could rewrite gg's install, the script included, before and after this change alike.
- Compiling still goes through `%TEMP%`: `Add-Type` writes the C# source there for the compiler, as it did on every
  call before. That exposure now applies once per source version instead of on every call.

## Considered options

- A prebuilt assembly checked in and loaded with `Add-Type -Path`. Rejected: Windows PowerShell compiles with the
  .NET Framework's C# 5 compiler, which has no deterministic build, so a reviewer cannot check that the binary
  matches the script's source, and Codex review cannot read a binary diff.
- A per-user cache under `%TEMP%`. Rejected: a Codex sandbox may write there.
- A per-user cache elsewhere in the user profile, with a hash file gg writes beside it. Rejected: for Codex it is no
  safer than the install directory, Claude's trusted-command mode can write anywhere in the profile, and it adds a
  second location to secure.

## Consequences

- Assemblies of about 8.5 KB stay in `lib/winjob-cache/`: one for each version of the script that has run, plus one
  for each extra helper that compiled at the same time on an empty cache. None are pruned.
- `lib/winjob-cache/` is gitignored, which also keeps it out of an npm package.
- Pre-warming PowerShell or replacing it remains out of scope. PowerShell's own start-up is still most of a cold call.
