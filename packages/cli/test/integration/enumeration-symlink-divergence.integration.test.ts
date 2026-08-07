/**
 * Two symlink behaviours the enumeration snapshot surfaced on its first run,
 * both previously unrecorded, both reachable from a plain `git clone`.
 *
 * ## 1. `followSymlinks: false` is honoured on one crawl route and ignored on the other
 *
 * `crawlDirectory` has two mutually exclusive routes. The recursive walk checks
 * `entry.isSymbolicLink()` and returns early unless `followSymlinks` is set, so
 * a symlink is never a member. The `git ls-files` route does no such check: git
 * returns mode-120000 entries like any other path, and the branch only
 * glob-filters. So the *same tree with the same options* has a different
 * population depending on whether a `.git` exists above it.
 *
 * ## 2. A committed dangling `*.md` symlink terminates the command
 *
 * On the git route that mode-120000 entry reaches `addResource` →
 * `parseMarkdown` → `readFile`, which throws `ENOENT`. `addResources` catches
 * only `DuplicateResourceIdError`, so the error escapes `registry.crawl` and
 * the process dies with a raw stack trace — not a validation finding, a crash.
 * Off the git route the identical tree is fine, because the walk never
 * enumerated the symlink at all.
 *
 * ⚠️ **These tests pin what VAT does TODAY, not what it should do.** Both are
 * genuine defects and both fixes change output on real corpora, so neither
 * belongs in the change that builds the instrument. When they are fixed, these
 * assertions flip — deliberately, in the change that fixes them, with a
 * changelog entry naming the population change.
 *
 * The 1.1 GB `~/.claude` baseline corpus is the reason this matters in
 * practice: it contains 15 deliberately-dangling `*.md` symlinks and has no
 * `.git`, which is the only reason recording that baseline succeeded.
 */
import { mkdtempSync, rmSync } from 'node:fs';

import { canCreateSymlinks, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  captureEnumerationSnapshot,
  laneById,
  materializeTrapCorpus,
} from '../../src/pipeline-oracles/index.js';

const roots: string[] = [];

/** A disposable corpus root, tracked for cleanup. */
function makeRoot(label: string): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), `vat-symlink-${label}-`));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('symlink enumeration diverges by crawl route', () => {
  it('enumerates resolvable symlinks on the git route and not on the walk route', async () => {
    const gitRoot = makeRoot('git');
    const walkRoot = makeRoot('walk');
    const gitBuilt = materializeTrapCorpus(gitRoot, { initGit: true });
    const walkBuilt = materializeTrapCorpus(walkRoot);

    if (!gitBuilt.symlinksCreated || !walkBuilt.symlinksCreated) {
      console.warn(
        'enumeration-symlink-divergence: this host cannot create symlinks (Windows without Developer Mode?); ' +
          'the route divergence was NOT exercised',
      );
      return;
    }
    expect(gitBuilt.gitInitialized, 'git init failed — is git on PATH?').toBe(true);

    const lane = laneById('resources');
    const onGit = await captureEnumerationSnapshot(lane, { corpusRoot: gitRoot, corpus: 'symlink/git' });
    const onWalk = await captureEnumerationSnapshot(lane, { corpusRoot: walkRoot, corpus: 'symlink/walk' });

    const gitPaths = onGit.enumerated.filter((row) => row.isSymlink).map((row) => row.path);
    const walkPaths = onWalk.enumerated.filter((row) => row.isSymlink).map((row) => row.path);

    expect([...gitPaths].sort((a, b) => a.localeCompare(b))).toEqual([
      'symlinks/a/link.md',
      'symlinks/b/link.md',
    ]);
    expect(walkPaths).toEqual([]);
  });

  it('gives two same-target-string symlinks two content keys', async () => {
    // Git stores the symlink's TARGET STRING as the blob, so both of these
    // share a blob SHA while resolving to different bytes. Keying on read makes
    // that collision unreachable; this is where a regression to a git-blob key
    // would be caught.
    const root = makeRoot('collide');
    const built = materializeTrapCorpus(root, { initGit: true });
    if (!built.symlinksCreated) {
      console.warn('enumeration-symlink-divergence: symlinks unavailable; blob-collision case NOT exercised');
      return;
    }

    const snapshot = await captureEnumerationSnapshot(laneById('resources'), {
      corpusRoot: root,
      corpus: 'symlink/collide',
    });
    const links = snapshot.enumerated.filter((row) => row.isSymlink);
    expect(links).toHaveLength(2);
    expect(links[0]?.contentKey).not.toBe(links[1]?.contentKey);
    for (const link of links) {
      expect(link.symlinkResolves).toBe(true);
      expect(link.contentKey).not.toBeNull();
    }
  });
});

describe('a committed dangling *.md symlink terminates every resource lane', () => {
  it('crashes on the git route and is invisible on the walk route', async () => {
    const gitRoot = makeRoot('dangling-git');
    const walkRoot = makeRoot('dangling-walk');
    if (!canCreateSymlinks(gitRoot)) {
      console.warn('enumeration-symlink-divergence: symlinks unavailable; the dangling-symlink crash was NOT exercised');
      return;
    }
    const gitBuilt = materializeTrapCorpus(gitRoot, { initGit: true, includeDanglingSymlink: true });
    materializeTrapCorpus(walkRoot, { includeDanglingSymlink: true });
    expect(gitBuilt.gitInitialized, 'git init failed — is git on PATH?').toBe(true);

    const lane = laneById('resources');
    const onGit = await captureEnumerationSnapshot(lane, { corpusRoot: gitRoot, corpus: 'dangling/git' });
    const onWalk = await captureEnumerationSnapshot(lane, { corpusRoot: walkRoot, corpus: 'dangling/walk' });

    // TODAY: the git route dies. The crawl still enumerated everything — it is
    // the parse that throws — so `enumerated` is populated and `admitted` is
    // empty, which is precisely the shape that distinguishes "this lane could
    // not run" from "this lane found nothing".
    expect(onGit.buildError).toMatch(/ENOENT/);
    expect(onGit.admitted).toEqual([]);
    expect(onGit.enumerated.length).toBeGreaterThan(0);
    expect(onGit.enumerated.some((row) => row.path === 'symlinks/dangling.md' && row.symlinkResolves === false)).toBe(true);

    // TODAY: the walk route never sees it, so the same tree validates cleanly.
    expect(onWalk.buildError).toBeUndefined();
    expect(onWalk.admitted.length).toBeGreaterThan(0);
    expect(onWalk.enumerated.some((row) => row.path === 'symlinks/dangling.md')).toBe(false);
  });
});
