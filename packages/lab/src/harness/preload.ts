/**
 * Getting a lab-built preload into the measured process: find it, and put it on
 * `NODE_OPTIONS` without disturbing anything already there.
 *
 * Shared by every facet whose instrument runs INSIDE vat via `--require` (`io`'s
 * counter, `memory`'s RSS probe). Both halves have a way to produce a plausible,
 * schema-valid report that is a lie, and a second copy is how one facet keeps the
 * guard and the other loses it.
 */

import { existsSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';

/** What to run when a preload has not been built. Named in the error, not implied. */
const BUILD_COMMAND = 'bunx tsc --build packages/lab/tsconfig.json';

/**
 * Locate a preload, or refuse to measure.
 *
 * Never falls back to running vat uninstrumented. A capture with no preload
 * produces a report of nothing — zero calls, no peak — and that is a number a
 * reader cannot tell from a real measurement, unlike a thrown error, which costs
 * one run and names its own remedy.
 *
 * @param who - The capture asking, for the message (`captureIo`)
 * @param what - The instrument, for the message (`I/O counter`)
 * @param path - Where it should be: the caller's override, or beside its module once built
 * @param consequence - What an uninstrumented run would report, in the facet's own terms
 * @returns Absolute path to the preload, forward-slashed
 * @throws {Error} when nothing is at that path
 */
export function resolvePreloadPath(who: string, what: string, path: string, consequence: string): string {
  const resolved = safePath.resolve(path);
  if (existsSync(resolved)) return resolved;

  throw new Error(
    `${who}: no ${what} at ${resolved}. Build it with \`${BUILD_COMMAND}\`, or pass its path. ` +
      `The capture will not run vat uninstrumented instead: that reports ${consequence}, and ` +
      'nothing in such a report says it is a lie.',
  );
}

/**
 * Build the `NODE_OPTIONS` for a measured run: whatever was already there, plus
 * the preload.
 *
 * **Appended, never assigned.** `runRepeats` applies this over `process.env`, so
 * an assignment drops an inherited `--max-old-space-size` or `--no-warnings` and
 * measures a differently-configured process while reporting it as the same one.
 *
 * **Quoted, and forward-slashed.** Both halves are required and neither is
 * obvious. Unquoted, `--require /Some Path/counter.cjs` parses as two arguments
 * and node dies looking for `/Some`. Quoted, Node's `NODE_OPTIONS` parser treats
 * a backslash inside the quotes as an escape — measured on Node 24.13.1,
 * `--require "/tmp/labq\back/x.cjs"` resolves to `/tmp/labqback/x.cjs` — so a
 * native Windows path would be silently mangled into one that does not exist.
 * `safePath.resolve` already yields forward slashes, which Node accepts on
 * Windows, and this is the reason it must.
 *
 * @param preloadPath - Absolute, forward-slashed path to the preload
 * @param base - `NODE_OPTIONS` as the child would otherwise have seen it
 * @returns The value to set for the measured run
 */
export function nodeOptionsWith(preloadPath: string, base: string | undefined): string {
  const preload = `--require "${preloadPath}"`;
  const existing = (base ?? '').trim();
  return existing === '' ? preload : `${existing} ${preload}`;
}
