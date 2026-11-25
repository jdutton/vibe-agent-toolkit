/**
 * Purity of a warm miss at the `node:fs` boundary: the multi-file layer reads no content of its
 * own. Every content read a miss makes in the `vat validate` process is a member's bytes, read
 * once (through the run's content cache), or one of the few files outside the population the
 * run is allowed to read: the VAT config, the schemas it names, and the ignore files. A lane that
 * reads a member a second time (a resolver opening a link target, say) or reads anything else is
 * a regression this catches, counted per path by the read probe (`fs-read-probe.cjs`).
 */

import { expect } from 'vitest';

import { isConfig, probed } from './work-counters-validate.js';

/** What a miss may read besides the config: project-relative paths. */
interface PurityAllowed {
  /** The keyed members: each read at most once. */
  readonly members: readonly string[];
  /** The schemas the VAT config names. */
  readonly schemas: readonly string[];
}

/** Whether a probed path is an ignore file VAT reads to decide membership. */
function isIgnoreFile(path: string): boolean {
  return path === '.gitignore' || path.endsWith('/.gitignore');
}

/**
 * Hold one run's parent-process reads to purity: every member read at most once, and nothing read
 * outside the members, the config, the named schemas and the ignore files.
 *
 * @param reads - The parent's content reads per probed path (`ValidateRunCounts.parentReads`)
 * @param cwd - The project root the run ran in
 * @param allowed - The members and schemas, project-relative
 */
export function expectPureMiss(reads: ReadonlyMap<string, number>, cwd: string, allowed: PurityAllowed): void {
  const members = new Set(allowed.members.map((path) => probed(cwd, path)));
  const schemas = new Set(allowed.schemas.map((path) => probed(cwd, path)));
  // Positive control: the probe saw the population read members, so an empty map is not a pass.
  expect([...reads.keys()].filter((path) => members.has(path)).length, 'the probe saw no member read').toBeGreaterThan(0);
  const twice = [...reads].filter(([path, count]) => members.has(path) && count > 1).map(([path, count]) => `${path} x${String(count)}`);
  expect(twice, 'a member read more than once in the parent').toEqual([]);
  const outside = [...reads.keys()].filter((path) => !members.has(path) && !schemas.has(path) && !isConfig(path) && !isIgnoreFile(path));
  expect(outside.toSorted((a, b) => a.localeCompare(b)), 'a path read outside the members, the config, its schemas and the ignore files').toEqual([]);
}
