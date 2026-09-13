/**
 * A link INTO a file the population could not read is reported, not skipped.
 *
 * ## 🪤 The defect these pin
 *
 * A target that `stat`s fine but cannot be READ (`chmod 000`) is dropped from the
 * population — `RESOURCE_UNREADABLE`, correct — and therefore from the fragment
 * index. Every link into it then passes existence (its parent lists fine), and
 * `checkAnchor` answers `'skip'` for its anchor exactly as for a non-markdown
 * target: "nothing to check". The link row said nothing and `linksChecked`
 * counted it. The neighbouring refused-DIRECTORY lane already says "its
 * existence and anchor are unverified" (`LINK_TARGET_UNREADABLE`); the
 * refused-FILE lane was silent on the link — the same "gap reads as clean"
 * shape one notch down, and one an adopter who suppresses `RESOURCE_UNREADABLE`
 * for a known-locked file never sees.
 *
 * ## What the judge is handed
 *
 * The registry already keeps the list of files it enumerated and could not read
 * (`getUnreadableResources()`); the judge reads a view of THAT list through
 * `JudgeLinkOptions.unreadableTargets` rather than a second ledger. These tests
 * hand the view in directly, which is also how a file that is readable on disk
 * stands in for one that was refused: what the judge sees is the declaration,
 * not the mode bits.
 */
import { FsLookupCache, safePath, setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  fragmentIndex,
  unreadableTargetsFrom,
  validateLink,
  type UnreadableTargets,
} from '../src/link-validator.js';

import { createLink, writeFileIn } from './test-helpers.js';

const suite = setupAsyncTempDirSuite('link-unreadable-target');

beforeAll(suite.beforeAll);
afterAll(suite.afterAll);
beforeEach(suite.beforeEach);

const TARGET = 'docs/sub/target.md';
const ANCHOR_HREF = './sub/target.md#nope';
const TREE = { 'docs/a.md': '# a\n', [TARGET]: '# target\n\n## sec\n' };

/** Plant `TREE` and return the project root. */
function plantTree(): string {
  const root = suite.getTempDir();
  for (const [relative, body] of Object.entries(TREE)) writeFileIn(root, relative, body);
  return root;
}

/** Judge one href written in `<root>/docs/a.md`. */
async function judge(
  root: string,
  href: string,
  options: { fragments?: Iterable<readonly [string, Set<string>]>; unreadableTargets?: UnreadableTargets } = {},
) {
  return await validateLink(
    createLink('local_file', href),
    safePath.join(root, 'docs', 'a.md'),
    fragmentIndex(options.fragments),
    {
      fsCache: new FsLookupCache(),
      projectRoot: root,
      skipGitIgnoreCheck: true,
      ...(options.unreadableTargets !== undefined && { unreadableTargets: options.unreadableTargets }),
    },
  );
}

describe('a link into a file the population could not read', () => {
  it('reports LINK_TARGET_UNREADABLE for an anchor into it, naming the file and the errno', async () => {
    const root = plantTree();
    const unreadableTargets = unreadableTargetsFrom([
      { filePath: safePath.join(root, TARGET), code: 'EACCES' },
    ]);

    const issue = await judge(root, ANCHOR_HREF, { unreadableTargets });

    expect(issue?.code).toBe('LINK_TARGET_UNREADABLE');
    expect(issue?.link).toBe(ANCHOR_HREF);
    // Project-relative, like every message in this lane — an absolute path
    // here is the developer's $HOME in a CI log.
    expect(issue?.message).toContain(TARGET);
    expect(issue?.message).not.toContain(root);
    expect(issue?.message).toContain('EACCES');
    // The whole point: what was NOT checked is said out loud, and the anchor
    // is named so the reader knows which claim is open.
    expect(issue?.message).toContain('#nope');
    expect(issue?.message).toContain('unverified');
    // It is not a broken-anchor report — VAT never saw the headings.
    expect(issue?.message).not.toContain('Anchor not found');
  });

  it('reports every anchor into it, not just the first', async () => {
    // The e2e shape: two links, two findings. A ledger that marked the file
    // "already reported" would leave the second link reading as clean.
    const root = plantTree();
    const unreadableTargets = unreadableTargetsFrom([{ filePath: safePath.join(root, TARGET) }]);

    const first = await judge(root, ANCHOR_HREF, { unreadableTargets });
    const second = await judge(root, './sub/target.md#nope-unreadable', { unreadableTargets });

    expect(first?.code).toBe('LINK_TARGET_UNREADABLE');
    expect(second?.code).toBe('LINK_TARGET_UNREADABLE');
    expect(second?.message).toContain('#nope-unreadable');
  });

  it('omits the errno clause when the platform supplied none', async () => {
    const root = plantTree();
    const unreadableTargets = unreadableTargetsFrom([{ filePath: safePath.join(root, TARGET) }]);

    const issue = await judge(root, ANCHOR_HREF, { unreadableTargets });

    expect(issue?.code).toBe('LINK_TARGET_UNREADABLE');
    expect(issue?.message).not.toContain('()');
    expect(issue?.message).not.toContain('undefined');
  });

  it('says nothing about a link WITHOUT an anchor — its existence was verified by the listing', async () => {
    // The file is on disk and its parent listed it; nothing about the LINK went
    // unchecked. The FILE's own refusal is `RESOURCE_UNREADABLE`, reported once
    // against the file, not once per link into it.
    const root = plantTree();
    const unreadableTargets = unreadableTargetsFrom([{ filePath: safePath.join(root, TARGET) }]);

    expect(await judge(root, './sub/target.md', { unreadableTargets })).toBeNull();
  });

  it('still reports a broken anchor when the same file WAS read', async () => {
    // The negative control for the distinction: readable → judged → broken.
    const root = plantTree();
    const target = safePath.join(root, TARGET);
    const fragments = [[target, new Set(['sec'])] as const];

    const broken = await judge(root, ANCHOR_HREF, { fragments });
    const valid = await judge(root, './sub/target.md#sec', { fragments });

    expect(broken?.code).toBe('LINK_BROKEN_ANCHOR');
    expect(valid).toBeNull();
  });

  it('still skips an anchor into a file that is simply not in the population', async () => {
    // Out of `include`, or not markdown: nothing declared it unreadable, so the
    // old `'skip'` is still the honest answer — VAT was never asked to read it.
    const root = plantTree();
    const unreadableTargets = unreadableTargetsFrom([]);

    expect(await judge(root, ANCHOR_HREF, { unreadableTargets })).toBeNull();
    expect(await judge(root, ANCHOR_HREF)).toBeNull();
  });

  it('fires only for the file that was refused, not for its neighbours', async () => {
    // A set keyed on the wrong thing (the directory, a prefix) would flag the
    // whole tree.
    const root = plantTree();
    const unreadableTargets = unreadableTargetsFrom([
      { filePath: safePath.join(root, 'docs', 'sub', 'other.md'), code: 'EACCES' },
    ]);

    expect(await judge(root, ANCHOR_HREF, { unreadableTargets })).toBeNull();
  });

  it('is reached only after existence: a MISSING target is still a broken file', async () => {
    const root = plantTree();
    const unreadableTargets = unreadableTargetsFrom([
      { filePath: safePath.join(root, 'docs', 'sub', 'nope.md'), code: 'EACCES' },
    ]);

    const issue = await judge(root, './sub/nope.md#x', { unreadableTargets });

    expect(issue?.code).toBe('LINK_BROKEN_FILE');
  });
});
