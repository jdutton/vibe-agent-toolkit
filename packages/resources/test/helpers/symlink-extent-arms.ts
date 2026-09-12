/**
 * The two crawl sources, run over one planted symlink fixture, per arm.
 *
 * `projection-filesystem-extent-symlink.test.ts` (a COMMITTED link) and
 * `projection-untracked-symlink-extent.test.ts` (an UNTRACKED one) ask the same
 * question of the same machinery and differ only in what the fixture stages — so
 * the plumbing between them is identical by intent, not by accident, and sharing
 * it is what keeps the two suites measuring the same subject when one is edited.
 *
 * **What lives here is the plumbing and nothing else.** No assertion, no control:
 * each suite's claim is only trustworthy because of the controls it states in its
 * own body (the mode-`120000` staging check, the untracked-listing check, the
 * positive-control regular file), and a helper that checked its own fixture would
 * hide the one thing those suites exist to prove is checked. See *"assertion
 * helpers"* in `docs/writing-tests.md`: return the value, let the caller assert.
 *
 * 🪤 The source is **injected** per arm rather than selected by `crawlSourceFor`.
 * A suite that ran whichever enumerator the host defaulted to would leave the
 * other unpinned while reading as if it had covered both — and the untracked
 * defect this pair now covers lived in exactly one arm.
 */

import { afterAll, beforeAll } from 'vitest';

import type { ExtentContribution } from '../../src/projection/contributor.js';
import { FilesystemExtentContributor } from '../../src/projection/contributors/filesystem-extent.js';
import {
  FilesystemCrawlSource,
  GitCrawlSource,
  type CrawlSource,
} from '../../src/projection/crawl-source.js';
import { buildExtentContribution } from '../test-helpers.js';

import {
  plantSymlinkFixture,
  removeSymlinkFixture,
  type SymlinkFixture,
  type SymlinkFixtureSpec,
} from './symlink-fixture.js';

/**
 * The two enumerators, named by the mechanism each uses to refuse a link.
 *
 * One list for both suites, so the arms cannot drift apart between them — the
 * whole point of pinning per-enumerator is that neither changes its mind alone.
 */
export const WALK_ARM = 'walk, followSymlinks: false';

/** {@link WALK_ARM}'s counterpart: git's snapshot plus its two prune listings. */
export const GIT_ARM = 'git snapshot + prune list';

export const SYMLINK_ARMS: readonly (readonly [string, (root: string) => CrawlSource])[] = [
  [WALK_ARM, (root: string): CrawlSource => new FilesystemCrawlSource(root)],
  [GIT_ARM, (root: string): CrawlSource => new GitCrawlSource(root)],
];

/** Live access to one planted fixture and the contribution each arm produced. */
export interface SymlinkExtentArms {
  /**
   * What `plantSymlinkFixture` returned — root plus the raw `git ls-files`
   * output for each tracking state, for the caller's own controls.
   *
   * @returns The planted fixture
   */
  fixture(): SymlinkFixture;
  /**
   * @param label - The arm's label, as it appears in {@link SYMLINK_ARMS}
   * @returns That arm's contribution over the fixture
   */
  contribution(label: string): ExtentContribution;
  /**
   * @param label - The arm's label, as it appears in {@link SYMLINK_ARMS}
   * @returns Root-relative realized paths, in emission order
   */
  paths(label: string): string[];
  /**
   * @param label - The arm's label, as it appears in {@link SYMLINK_ARMS}
   * @returns Root-relative realized paths, sorted, for comparing two arms
   */
  sortedPaths(label: string): string[];
  /**
   * Where the two arms differ — the whole point of running both.
   *
   * A difference, not a verdict: an empty pair is worthless on its own, since
   * two arms that each enumerated nothing agree perfectly. The caller states its
   * own positive control before reading this.
   *
   * @returns Paths one arm realized and the other did not, sorted
   */
  armDisagreements(): { onlyWalk: string[]; onlyGit: string[] };
}

/**
 * Plant one fixture and run every arm over it, in this suite's `beforeAll`.
 *
 * Call it at `describe` scope; it registers its own `beforeAll`/`afterAll` and
 * hands back getters rather than values, because nothing exists until the hook
 * has run.
 *
 * @param spec - What to plant, passed through to `plantSymlinkFixture`
 * @returns Getters for the fixture and each arm's contribution
 */
export function setupSymlinkExtentSuite(spec: SymlinkFixtureSpec): SymlinkExtentArms {
  let planted: SymlinkFixture | undefined;
  const byArm = new Map<string, ExtentContribution>();

  beforeAll(async () => {
    planted = plantSymlinkFixture(spec);
    for (const [label, sourceFor] of SYMLINK_ARMS) {
      const { contribution } = await buildExtentContribution(
        planted.root,
        new FilesystemExtentContributor(sourceFor),
      );
      byArm.set(label, contribution);
    }
  });

  afterAll(() => {
    removeSymlinkFixture(planted?.root);
  });

  const contribution = (label: string): ExtentContribution => {
    const found = byArm.get(label);
    if (found === undefined) throw new Error(`no contribution recorded for arm "${label}"`);
    return found;
  };
  const paths = (label: string): string[] =>
    contribution(label).realizations.map((row) => row.path);
  const sortedPaths = (label: string): string[] => paths(label).sort((a, b) => a.localeCompare(b));

  return {
    fixture: () => {
      if (planted === undefined) throw new Error('fixture not planted — is this outside beforeAll?');
      return planted;
    },
    contribution,
    paths,
    sortedPaths,
    armDisagreements: () => {
      const walk = new Set(sortedPaths(WALK_ARM));
      const git = new Set(sortedPaths(GIT_ARM));
      return {
        onlyWalk: [...walk].filter((path) => !git.has(path)),
        onlyGit: [...git].filter((path) => !walk.has(path)),
      };
    },
  };
}
