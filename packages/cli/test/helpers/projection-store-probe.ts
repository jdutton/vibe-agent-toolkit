/* eslint-disable security/detect-non-literal-fs-filename -- every path here is a temp tree the calling test owns */
/**
 * Observing what a spawned `vat` run did with the **projection store**.
 *
 * Shared by the suites that measure the store from outside the process, because
 * the store's effects are only visible on disk and in the crawl-timing dump:
 *
 * - `projection-store-cache-control.integration.test.ts` — that the cache
 *   controls reach it across the spawn.
 * - `projection-store-equivalence.integration.test.ts` — that the ANSWER is the
 *   same whether or not it is engaged.
 *
 * ## 🪤 Rows, never file size
 *
 * A SQLite database allocates by page, so a store holding nothing and a store
 * holding a whole corpus can both be 118,784 bytes. Everything here counts ROWS,
 * out of the file, with the store's own connection closed.
 *
 * ## 🪤 Which variable names the temp directory is PLATFORM-SPECIFIC
 *
 * `defaultStoreDirectory()` derives from the OS temp directory and there is no
 * env var to point it elsewhere, so isolating an arm means isolating its
 * `os.tmpdir()`. Under `normalizedTmpdir()` that reads `TMPDIR` on POSIX and
 * `TEMP`, then `TMP`, on Windows — no name both platforms honour. Setting
 * `TMPDIR` alone is inert on Windows: the child resolves the runner's real temp
 * directory, writes its store there, and every assertion reads an isolated
 * directory no run ever touched, which passes every "nothing was written" arm
 * VACUOUSLY. {@link tmpdirEnv} sets all three.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { safePath } from '@vibe-agent-toolkit/utils';

/**
 * Point a child's `os.tmpdir()` at one directory on every platform.
 *
 * @param temp - The arm's private temp directory
 * @returns The env pairs to merge, covering the POSIX and the Windows names
 */
export function tmpdirEnv(temp: string): Record<string, string> {
  return { TMPDIR: temp, TMP: temp, TEMP: temp };
}

/**
 * Every `projection.db` under one isolated temp directory.
 *
 * Searched rather than derived: the path carries a release namespace and a
 * projection shape digest, and restating either here would make a caller fail
 * for a reason that has nothing to do with the store. Finding none is a real
 * answer — no store was ever opened.
 *
 * @param root - The isolated temp directory an arm ran under
 * @returns Absolute paths of every store file found, in walk order
 */
export function storeFilesUnder(root: string): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = safePath.join(directory, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.name === 'projection.db') found.push(child);
    }
  };
  visit(root);
  return found;
}

/**
 * Rows held across every table of every store under one temp directory.
 *
 * @param root - The isolated temp directory an arm ran under
 * @returns Total rows, which is 0 both for "no store file" and "an empty one"
 */
export function rowsStoredUnder(root: string): number {
  let total = 0;
  for (const file of storeFilesUnder(root)) {
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      for (const { name } of database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]) {
        total += (database.prepare(`SELECT COUNT(*) AS total FROM "${name}"`).get() as { total: number }).total;
      }
    } finally {
      database.close();
    }
  }
  return total;
}

/**
 * Which contributors a run charged time to, as `VAT_CRAWL_TIMING` recorded them.
 *
 * @param timingDir - The directory one arm's `VAT_CRAWL_TIMING` pointed at
 * @returns Every charged contributor id, with repeats — one per recorded pass
 */
export function contributorsCharged(timingDir: string): string[] {
  return readdirSync(timingDir).flatMap((file) => {
    const dump = JSON.parse(readFileSync(safePath.join(timingDir, file), 'utf-8')) as {
      entries: { contributorId: string }[];
    };
    return dump.entries.map((entry) => entry.contributorId);
  });
}
