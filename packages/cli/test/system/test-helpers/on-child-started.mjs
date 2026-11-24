/**
 * Shared by the child-only stall preloads: run `onStarted` right after the supervised child's
 * progress writer appends its `started` entry.
 *
 * The progress writer is a synchronous `fs.appendFileSync`, so the hook patches it and calls
 * `onStarted` once the call carrying `"kind":"started"` has returned, the entry already on disk.
 * The caller runs `syncBuiltinESMExports()` after all its patches, so the ESM `node:fs` binding the
 * writer imports sees this one.
 *
 * @param {() => void} onStarted - What the preload does once `started` is on disk
 */
import fs from 'node:fs';

export function onChildStarted(onStarted) {
  const append = fs.appendFileSync;
  fs.appendFileSync = (path, data, ...rest) => {
    const result = append(path, data, ...rest);
    if (typeof data === 'string' && data.includes('"kind":"started"')) onStarted();
    return result;
  };
}
