/**
 * A stand-in for the supervised checks child, spawned for real by `superviseRun` (the test points
 * `resolveVatBinPath` here). It ignores the supervisor's own flags and acts on its first three
 * arguments: `<mode> <document file> <trigger file>`.
 *
 * - `quick`: writes `early stderr` to stderr and the document to stdout, then exits 0.
 * - `follow`: writes `early stderr`, waits for `<trigger>`, writes `late stderr`, waits for
 *   `<trigger>.exit`, then publishes the document and exits 0. The supervisor creates the second
 *   trigger only once it has seen `late stderr`, so that line reached it while this process ran.
 * - `grandchild`: starts a grandchild holding this process's stdout and exits 0 at once, writing
 *   nothing; the grandchild publishes the document once `<trigger>` exists. The stdout pipe stays
 *   open after this process exits, so only the post-exit grace decides what was read.
 * - `hang`: writes `early stderr` and stays alive until killed.
 *
 * Every wait gives up after a bound, so a broken supervisor fails its test instead of leaking a
 * process.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const [mode, documentFile, trigger] = process.argv.slice(2);
const WAIT_BOUND_MS = 8000;
const POLL_MS = 10;
const EARLY = 'early stderr\n';

/** Resolve once `path` exists, or after the bound. */
function waitFor(path) {
  const deadline = Date.now() + WAIT_BOUND_MS;
  return new Promise((resolve) => {
    const look = () => {
      if (existsSync(path) || Date.now() > deadline) resolve();
      else setTimeout(look, POLL_MS);
    };
    look();
  });
}

function publish() {
  process.stdout.write(readFileSync(documentFile, 'utf-8'));
}

if (mode === 'quick') {
  process.stderr.write(EARLY);
  publish();
} else if (mode === 'follow') {
  process.stderr.write(EARLY);
  await waitFor(trigger);
  process.stderr.write('late stderr\n');
  await waitFor(`${trigger}.exit`);
  publish();
} else if (mode === 'grandchild') {
  spawn(process.execPath, [process.argv[1], 'grandchild-writer', documentFile, trigger], { stdio: ['ignore', 'inherit', 'ignore'] }).unref();
} else if (mode === 'grandchild-writer') {
  await waitFor(trigger);
  publish();
} else if (mode === 'hang') {
  process.stderr.write(EARLY);
  setTimeout(() => undefined, WAIT_BOUND_MS);
}
