/**
 * Shared by the parent-only preloads: hand each OVERLAPPED checks child this process spawns to
 * `observe`, right after the spawn. An overlapped child carries `--supervised-by` and gets a file
 * descriptor for its stderr; a sequential child gets `'inherit'` and is never observed.
 *
 * The caller runs `syncBuiltinESMExports()` once its patches are in place, so the named `spawn`
 * import the supervisor uses sees this one.
 */
import childProcess from 'node:child_process';

/**
 * Patch `childProcess.spawn` so `observe(child)` runs for each overlapped checks child.
 *
 * @param {(child: import('node:child_process').ChildProcess) => void} observe - Runs right after the spawn
 */
export function onOverlappedSpawn(observe) {
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, args, options, ...rest) => {
    const child = spawn(command, args, options, ...rest);
    if (Array.isArray(args) && args.includes('--supervised-by') && typeof options?.stdio?.[2] === 'number') observe(child);
    return child;
  };
}
