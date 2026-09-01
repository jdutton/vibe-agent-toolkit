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
 * ## How an arm's store is isolated
 *
 * `VAT_PROJECTION_STORE_DIR` names the directory outright, and it is the only
 * mechanism either suite uses. `defaultStoreDirectory()` is one database per VAT
 * release, shared by every root on the machine, so an arm that does not redirect
 * it is reading and writing the developer's live cache.
 *
 * 🪤 Both suites import the variable's NAME from the module under test rather
 * than spelling it here, and that is not tidiness. A store nothing redirected
 * lands in the shared default, so every probe below then reads a directory no
 * run ever touched — and each one answers `[]` or `0`, which is exactly what a
 * clean "nothing was written" arm looks like. The isolation and the assertions
 * fail silently in the same direction, so only a positive control (an arm that
 * requires rows to BE there) can tell the two apart.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { safePath } from '@vibe-agent-toolkit/utils';

/**
 * Every `projection.db` under one isolated temp directory.
 *
 * Searched rather than derived: the path carries a release namespace and a
 * projection shape digest, and restating either here would make a caller fail
 * for a reason that has nothing to do with the store. Finding none is a real
 * answer — no store was ever opened.
 *
 * @param root - The directory one arm's store was isolated to
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
 * @param root - The directory one arm's store was isolated to
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
