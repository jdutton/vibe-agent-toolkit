/**
 * Purity of a warm miss at the `node:fs` boundary: the multi-file layer reads no content of its
 * own. A git member's bytes are read from git's object store (through the run's content cache),
 * never from disk: the `vat validate` process opens a member at most once, for the readability
 * probe (an open and a close, no bytes: the probe counts a read-only open), so an unreadable
 * member is reported as a disk read would report it. What else it may read is the
 * few files outside the population: the VAT config, the schemas it names, the ignore files, and
 * git's own state under `.git/`. A lane that reads a member from disk (a resolver opening a link
 * target, say) or reads anything else is a regression this catches, counted per path by the read
 * probe (`fs-read-probe.cjs`).
 */

import { expect } from 'vitest';

import { isConfig, isGitInternal, probed } from './work-counters-validate.js';

/** What a miss may read besides the config: project-relative paths. */
interface PurityAllowed {
  /** The keyed git members: opened at most once, for the readability probe, never read from disk. */
  readonly members: readonly string[];
  /** The schemas the VAT config names. */
  readonly schemas: readonly string[];
}

/** Whether a probed path is an ignore file VAT reads to decide membership. */
function isIgnoreFile(path: string): boolean {
  return path === '.gitignore' || path.endsWith('/.gitignore');
}

/**
 * Hold one run's parent-process reads to purity: no member opened more than its one probe, and nothing read but
 * the config, the named schemas, the ignore files and git's own state.
 *
 * @param reads - The parent's content reads per probed path (`ValidateRunCounts.parentReads`)
 * @param cwd - The project root the run ran in
 * @param allowed - The members and schemas, project-relative
 */
export function expectPureMiss(reads: ReadonlyMap<string, number>, cwd: string, allowed: PurityAllowed): void {
  const members = new Set(allowed.members.map((path) => probed(cwd, path)));
  const schemas = new Set(allowed.schemas.map((path) => probed(cwd, path)));
  // Positive control: the probe saw a member's one disk access, its readability open, so an empty
  // map is not a pass, and neither is a probe that watches the config but not the members.
  expect([...reads.keys()].filter((path) => members.has(path)).length, 'the probe saw no member\'s readability open').toBeGreaterThan(0);
  const fromDisk = [...reads].filter(([path, count]) => members.has(path) && count > 1).map(([path, count]) => `${path} x${String(count)}`);
  expect(fromDisk, 'a git member opened past its readability probe in the parent').toEqual([]);
  const outside = [...reads.keys()].filter((path) => !members.has(path) && !schemas.has(path) && !isConfig(path) && !isIgnoreFile(path) && !isGitInternal(path));
  expect(outside.toSorted((a, b) => a.localeCompare(b)), 'a path read outside the config, its schemas, the ignore files and git\'s state').toEqual([]);
}
