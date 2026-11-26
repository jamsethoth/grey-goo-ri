// What an argv starts as with no shell, which exec's run and launch share: on Windows an npm .cmd shim for a node bin
// is read for the script it names (#423).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';

// A shim's end, as npm's cmd-shim writes it: the program, then the script beside the shim, then the arguments.
const NPM_SHIM = /"%_prog%"\s+"%dp0%\\([^"]+)"\s+%\*/;
// A shim for a node bin: its program is node, and it sets no variable (cmd-shim writes an @SET line for each).
const NODE_SHIM = /^\s*SET "_prog=node"\s*$/m;
const SHIM_VARIABLE = /^@SET /m;

// What an argv starts with no shell. On Windows a name found first on PATH as a .cmd or .bat, or a path to one, is an
// npm shim, which only cmd.exe can run: it starts node on the script the shim names instead, its own node.exe when
// it has one, as the shim does. Any other .cmd, a shim for a bin that is not node or that sets a variable among them,
// is refused, since running it takes a shell. A relative path or PATH entry is read from cwd, as spawn reads it. An
// .exe or .com found first starts as named.
// A test passes stat to model a candidate it may not read.
export function argvOf(
  command: string,
  args: string[],
  {
    path = process.env.PATH ?? '',
    cwd = process.cwd(),
    stat = (file) => statSync(file, { throwIfNoEntry: false }),
  }: { path?: string; cwd?: string; stat?: (file: string) => { isFile(): boolean } | undefined } = {},
) {
  if (process.platform !== 'win32') return { command, args };
  const candidates = /[\\/]/.test(command)
    ? [resolve(cwd, command)]
    : path
        .split(';')
        .filter(Boolean)
        .flatMap((directory) =>
          (extname(command) ? [''] : ['.com', '.exe', '.bat', '.cmd']).map((extension) =>
            resolve(cwd, directory.replace(/"/g, ''), command + extension),
          ),
        );
  const found = candidates.find((file) => {
    // A Store app's execution alias is a link the user may not stat: found, not a shim, so it starts as named (#531)
    try {
      return stat(file)?.isFile();
    } catch {
      return true;
    }
  });
  if (!found || !/\.(?:cmd|bat)$/i.test(found)) return { command, args };
  const text = readFileSync(found, 'utf8');
  const script = NODE_SHIM.test(text) && !SHIM_VARIABLE.test(text) ? NPM_SHIM.exec(text)?.[1] : undefined;
  if (!script) throw new Error(`${found} is not an npm shim: gg runs no .cmd through a shell`);
  const ownNode = join(dirname(found), 'node.exe');
  return { command: existsSync(ownNode) ? ownNode : 'node', args: [join(dirname(found), script), ...args] };
}
