/**
 * Test-only preload (`NODE_OPTIONS=--import "<file: URL>"`): the SUPERVISING process's spawn of its
 * checks child fails at the OS: the command it names does not exist, so the spawn emits `error`
 * (`ENOENT`) and no child ever runs.
 *
 * Only the checks child's spawn (its argv carries `--supervised-by`) is redirected, to the real
 * command's path with a suffix that names nothing; every other spawn (git) is the real one. The
 * named `spawn` import the supervisor uses sees the patch through `syncBuiltinESMExports()`.
 *
 * Acts only in a process whose argv does NOT carry `--supervised-by` (a supervisor, never the child it
 * spawns). VAT's source gains no knob for this.
 */
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

if (!process.argv.includes('--supervised-by')) {
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, ...rest) => {
    const checksChild = Array.isArray(args) && args.includes('--supervised-by');
    return spawn(checksChild ? `${String(command)}-vat-test-missing` : command, args, ...rest);
  };
  syncBuiltinESMExports();
}
