---
status: accepted
date: 2026-11-18
---

# Claude runs in Trusted-Command Mode on every platform, with gg's own read-only commands on Windows

Amends ADR 0007 for the Claude Harness's declaration (grey-goo-ri issue #424, part of epic #421). ADR 0007 named
Trusted-Command Mode for Claude on native Windows. Slice 2's launch profile (request 3.2) turns no Claude sandbox on
anywhere, runs PowerShell as Claude's shell on win32 (G5 C), and bounds every call by an allow and a deny list. The
owner decided 1 to 8 on 2026-11-16 and Clarify's Q1 to Q3 on 2026-11-18.

1. **Trusted-Command Mode on every platform.** Claude's `confinement` Capability is `trusted-commands` on Linux and
   macOS too (Q3 A): Claude's own sandbox runs there only with `sandbox.enabled`, which the profile does not set, so
   every platform runs the same allow and deny lists. A later ticket that adopts Claude's sandbox changes the value.
2. **The read-only commands on Windows are gg's own.** Claude's built-in read-only command set joins the allow list
   under Bash (G6). It is documented for Bash only, so on win32 gg allows its own: `Get-ChildItem`, `Get-Content`,
   `Select-String` and read-only git, until #425's probe finds a built-in set for PowerShell.
   Amended 2026-11-19 (grey-goo-ri issue #425, owner Q5 A): the recording found Claude's built-in read-only set on
   PowerShell too (`Get-ChildItem`, `Get-Content`, `Get-Location`, `Test-Path` and `Select-String` ran with gg's
   list removed), so gg drops its own list: on every shell the allow list is the Declared Commands and read-only git,
   beside Claude's built-in set. The launch profile rises to version 2. This supersedes the title's "with gg's own
   read-only commands on Windows".
3. **gg's settings file sets `permissions.blockWritesOutsideWorkingDirectories: true`.** gg claims it for the file
   tools only; it is claimed for shell commands once #425's probe shows it covers them. Until then a command that
   writes elsewhere is neither prevented nor observed, as ADR 0007 states.
   Amended 2026-11-19 (grey-goo-ri issue #425): the probe did not show it covers shell commands. The Write tool outside
   the repository was refused with a message naming the setting; the shell writes outside were refused as needing
   approval, with no message naming it. gg still claims it for the file tools only.
4. **A read-only call keeps its shell.** ADR 0007 said read-only steps use the restricted mode, which removes shell
   access. `--restricted` removes the command-running tools unless `--tools` names them, and the profile names the
   shell in `--tools` for every call (decision 4, G18 A), so a read-only Agent runs commands under the read-only allow
   list and `--permission-mode manual`, with `--permission-prompts none` refusing the rest.
5. **No prefixed twins of the permission rules** (replaced by ADR 0031, grey-goo-ri issue #481 decision 6, Q13' A): a
   command a hook rewrites fails closed under the default-deny rules, as #479 showed; #488 keeps declared prefixes in
   the backlog.

## Considered options

- `trusted-commands` on win32 and none elsewhere (Q3 B). Rejected: Linux and macOS Events would record no confinement
  while running the same unsandboxed lists, and the value would depend on the platform the module loads on.
- Porting feature-flow's twin helper with no prefixes (Q2 B). Rejected: it twins only `Bash(` rules and closes nothing
  without a prefix, so slice 3 would rewrite it.

## Consequences

The Claude Harness declares `confinement: 'trusted-commands'` as a constant, and GLOSSARY.md's Trusted-Command Mode
covers every platform. #425's probes settle points 2 and 3; if they fail, win32 falls back to Bash with Git Bash and the
same rule table.
