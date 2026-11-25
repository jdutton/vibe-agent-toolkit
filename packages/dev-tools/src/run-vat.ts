#!/usr/bin/env tsx
/**
 * The root `vat` script: run this checkout's built `vat` with this checkout's own
 * cache root.
 *
 * Sets `VAT_CACHE_DIR` when the environment leaves it unset or empty, to a directory
 * under the temp directory named by a digest of this checkout's path, then runs the
 * CLI wrapper (`packages/cli/dist/bin/vat.js`) in this process with the same
 * arguments. Running it in-process, not as a child, leaves stdio, the exit code and
 * signal handling exactly the CLI wrapper's own. A `VAT_CACHE_DIR` already set (CI's
 * `$RUNNER_TEMP/vat-cache`, its persisted cache; a test's own directory) passes
 * through unchanged.
 *
 * Why: the cache namespace is the VAT version alone, so two checkouts of one version
 * running different extractor code share every row under one cache root. Every `vat`
 * step of the gate runs as `bun run vat ...` (and the audit gate spawns `bun run vat
 * audit`), so this one script gives the gate, and a hand run, a cache per checkout.
 *
 * Outside the checkout on purpose: a cache root inside the scanned tree draws an
 * operator notice from every `vat` step that scans the repo root.
 */

import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';

import { isEntrypoint, PROJECT_ROOT } from './common.js';

/** The directory under the temp directory that holds one cache root per checkout. */
const CHECKOUT_CACHES = '.vat-cache-checkouts';

/**
 * The cache root a `vat` run from a checkout uses.
 *
 * @param env - The environment the run was started with
 * @param checkoutRoot - The checkout's absolute path
 * @param temp - The temp directory
 * @returns `env.VAT_CACHE_DIR` when non-empty, else `<temp>/.vat-cache-checkouts/<digest of checkoutRoot>`
 */
export function checkoutVatCacheDir(
  env: Readonly<Record<string, string | undefined>>,
  checkoutRoot: string,
  temp: string,
): string {
  const configured = env[VAT_CACHE_DIR_ENV];
  if (configured !== undefined && configured !== '') return configured;
  const digest = createHash('sha256').update(checkoutRoot).digest('hex').slice(0, 16);
  return safePath.join(temp, CHECKOUT_CACHES, digest);
}

if (isEntrypoint(import.meta.url)) {
  process.env[VAT_CACHE_DIR_ENV] = checkoutVatCacheDir(process.env, PROJECT_ROOT, normalizedTmpdir());
  // The CLI wrapper runs `main()` on import, reading `process.argv.slice(2)`: the same arguments.
  await import(pathToFileURL(safePath.join(PROJECT_ROOT, 'packages/cli/dist/bin/vat.js')).href);
}
