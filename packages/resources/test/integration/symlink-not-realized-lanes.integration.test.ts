/**
 * Both populating lanes carry every declined-link row into the
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
import {
  EXTENT_SYMLINK_NOT_REALIZED,
  EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT,
  EXTENT_SYMLINK_TARGET_UNRESOLVED,
  isDeclinedSymlinkCode,
} from '../../src/projection/contributors/filesystem-extent.js';
import { DISCARD_BLOB_POPULATION } from '../../src/projection/merge.js';
import { buildResourceProjection } from '../../src/projection/resource-population.js';
import { plantSymlinkFixture, removeSymlinkFixture } from '../helpers/symlink-fixture.js';

const CLAUDE_TARGET = 'other/CLAUDE.md';
const CLAUDE_LINK = 'link/CLAUDE.md';
const RULE_LINK = '.claude/rules/linked.md';
/** A rules link whose target leaves the root — the other declined-link code. */
const OUTSIDE_RULE_LINK = '.claude/rules/vendored.md';
/** Named only by that link's target text — it must reach no row. */
const OUTSIDE_NAME = 'vat-lanes-outside-rules.md';
const IGNORED_LINK = 'ignored/link.md';
/** A rules link that dangles in-root — the third declined-link code. */
const DANGLING_RULE_LINK = '.claude/rules/dangling.md';

describe.skipIf(!symlinkCapability())('declined symlinks reach the projection on both lanes', () => {
  let root: string | undefined;

  beforeAll(() => {
    root = plantSymlinkFixture({
      prefix: 'vat-symlink-lanes-',
      files: [CLAUDE_TARGET, 'shared/rule.md'],
      links: [
        { path: CLAUDE_LINK, target: '../other/CLAUDE.md' },
        { path: RULE_LINK, target: '../../shared/rule.md' },
        // Enough `..` to leave any temp root, however deep the host puts it.
        { path: OUTSIDE_RULE_LINK, target: `${'../'.repeat(24)}${OUTSIDE_NAME}` },
        { path: DANGLING_RULE_LINK, target: '../../nope/missing.md' },
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

    const declined = projection.realizationConditions.filter((row) => isDeclinedSymlinkCode(row.code));
    const paths = declined.map((row) => row.path);
    const codeAt = (path: string): string | undefined => declined.find((row) => row.path === path)?.code;
    // Positive control: the lane realized the link's target.
    expect(projection.resourceRealizations.map((row) => row.path)).toContain(CLAUDE_TARGET);
    expect(paths).toContain(CLAUDE_LINK);
    expect(paths).toContain(RULE_LINK);
    // ⭐ EVERY code survives the replay. The out-of-root arm is the one whose
    // rule Claude Code does not load at all, so a replay that carried only the
    // general code would empty exactly the lane that matters most.
    expect(codeAt(RULE_LINK)).toBe(EXTENT_SYMLINK_NOT_REALIZED);
    expect(codeAt(OUTSIDE_RULE_LINK)).toBe(EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT);
    expect(codeAt(DANGLING_RULE_LINK)).toBe(EXTENT_SYMLINK_TARGET_UNRESOLVED);
    // Both lanes decline gitignored rows, so the ignored link is declined with them.
    expect(paths).not.toContain(IGNORED_LINK);
    // Neither code names what lies outside the root.
    for (const row of declined) expect(row.message, row.path).not.toContain(OUTSIDE_NAME);
  });
});
