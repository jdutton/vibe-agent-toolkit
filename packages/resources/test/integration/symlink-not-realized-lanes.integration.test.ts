/**
 * Both populating lanes carry `EXTENT_SYMLINK_NOT_REALIZED` rows into the
 * projection a `vat resources query` reads — the resources lane (every
 * statement) and the Claude-context lane (every statement naming
 * `claude_context_chains` / `claude_context_loads`).
 *
 * The contributor-level behaviour — both enumerators, every tracking state,
 * every target shape, no leaked path — is `../projection-symlink-not-realized.test.ts`.
 * What this adds is the wiring: the Claude-context lane replays a SHARED
 * enumeration into two populations, and a replay that dropped the declined links
 * would silently empty exactly the lane the rows exist for.
 */

import { symlinkCapability } from '@vibe-agent-toolkit/utils';
import { GitTracker } from '@vibe-agent-toolkit/utils/git';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildClaudeContextPopulation } from '../../src/projection/claude-context-population.js';
import { EXTENT_SYMLINK_NOT_REALIZED } from '../../src/projection/contributors/filesystem-extent.js';
import { DISCARD_BLOB_POPULATION } from '../../src/projection/merge.js';
import { buildResourceProjection } from '../../src/projection/resource-population.js';
import { plantSymlinkFixture, removeSymlinkFixture } from '../helpers/symlink-fixture.js';

const CLAUDE_TARGET = 'other/CLAUDE.md';
const CLAUDE_LINK = 'link/CLAUDE.md';
const RULE_LINK = '.claude/rules/linked.md';
const IGNORED_LINK = 'ignored/link.md';

describe.skipIf(!symlinkCapability())('declined symlinks reach the projection on both lanes', () => {
  let root: string | undefined;

  beforeAll(() => {
    root = plantSymlinkFixture({
      prefix: 'vat-symlink-lanes-',
      files: [CLAUDE_TARGET, 'shared/rule.md'],
      links: [
        { path: CLAUDE_LINK, target: '../other/CLAUDE.md' },
        { path: RULE_LINK, target: '../../shared/rule.md' },
      ],
      ignore: ['ignored/'],
      untrackedLinks: [{ path: IGNORED_LINK, target: '../other/CLAUDE.md' }],
    }).root;
  });

  afterAll(() => {
    removeSymlinkFixture(root);
  });

  it.each([
    ['the resources lane', buildResourceProjection],
    ['the Claude-context lane', buildClaudeContextPopulation],
  ] as const)('%s', async (_label, build) => {
    if (root === undefined) throw new Error('fixture not planted');
    const gitTracker = new GitTracker(root);
    await gitTracker.initialize({ includeUntracked: true });
    const projection = await build({ root, gitTracker, onBlobPopulation: DISCARD_BLOB_POPULATION });

    const paths = projection.realizationConditions
      .filter((row) => row.code === EXTENT_SYMLINK_NOT_REALIZED)
      .map((row) => row.path);
    // Positive control: the lane realized the link's target.
    expect(projection.resourceRealizations.map((row) => row.path)).toContain(CLAUDE_TARGET);
    expect(paths).toContain(CLAUDE_LINK);
    expect(paths).toContain(RULE_LINK);
    // Both lanes decline gitignored rows, so the ignored link is declined with them.
    expect(paths).not.toContain(IGNORED_LINK);
  });
});
