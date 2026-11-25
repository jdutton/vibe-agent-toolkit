#!/usr/bin/env tsx
/**
 * Print the VAT cache root this checkout's gate uses: `VAT_CACHE_DIR` when it
 * is set, else a directory under the temp directory named by a digest of this
 * checkout's path.
 *
 * The cache namespace is the VAT version alone, so two checkouts of one
 * version running different extractor code share every row under one cache
 * root: without this, parallel worktrees on the default `<tmpdir>/.vat-cache`
 * are served each other's facts. The root `validate` script captures this
 * output into `VAT_CACHE_DIR` for every step it runs. CI sets `VAT_CACHE_DIR`
 * itself (`$RUNNER_TEMP/vat-cache`, its persisted cache) and gets it back
 * unchanged.
 *
 * Outside the checkout on purpose: a cache root inside the scanned tree draws
 * an operator notice from every `vat` step that scans the repo root.
 *
 * Dependency-free: `bun run validate` runs this before its Build step, so no
 * workspace package is built yet.
 */

/* eslint-disable local/no-raw-node-path -- Runs before the build; cannot import safePath from utils */

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The directory under the temp directory that holds one cache root per checkout. */
const CHECKOUT_CACHES = '.vat-cache-checkouts';

/**
 * The cache root for a checkout.
 *
 * @param configured - `VAT_CACHE_DIR` as the environment has it
 * @param checkoutRoot - The checkout's absolute path
 * @param temp - The temp directory
 * @returns `configured` when non-empty, else `<temp>/.vat-cache-checkouts/<digest of checkoutRoot>`
 */
export function gateVatCacheDir(configured: string | undefined, checkoutRoot: string, temp: string): string {
  if (configured !== undefined && configured !== '') return configured;
  const digest = createHash('sha256').update(checkoutRoot).digest('hex').slice(0, 16);
  return `${temp}/${CHECKOUT_CACHES}/${digest}`;
}

const invokedPath = process.argv[1];
// `isEntrypoint` lives in utils, unbuilt when this runs. The invoked path is realpathed, as Node
// realpaths the main module's own URL, so a symlinked invocation still compares equal.
// eslint-disable-next-line local/no-fragile-entrypoint-guard, local/no-link-following-fs, local/no-fs-realpathSync -- utils is unbuilt when this runs; the path is the operator's own invocation
if (invokedPath !== undefined && import.meta.url === pathToFileURL(realpathSync(invokedPath)).href) {
  const checkoutRoot = resolve(fileURLToPath(import.meta.url), '../../../..');
  // eslint-disable-next-line local/no-os-tmpdir -- utils (normalizedTmpdir) is unbuilt when this runs; the name only needs to be stable per checkout
  process.stdout.write(gateVatCacheDir(process.env['VAT_CACHE_DIR'], checkoutRoot, tmpdir()));
}
