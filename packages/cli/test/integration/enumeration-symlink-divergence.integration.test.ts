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
 * ## 2. A committed dangling `*.md` symlink — FIXED, and these assertions flipped
 *
 * On the git route that mode-120000 entry reaches `addResource` →
 * `parseMarkdown` → `readFile`, which throws `ENOENT`. `addResources` used to
 * catch only `DuplicateResourceIdError`, so the error escaped `registry.crawl`
 * and the process died with a raw stack trace — not a validation finding, a
 * crash. It is now recorded and reported as `RESOURCE_UNREADABLE`.
 *
 * The assertions below were flipped in that change, as this docstring said they
 * should be. They deliberately still check that the file is **enumerated and
 * not admitted**: "no crash" alone would also be satisfied by making the crawl
 * skip the entry, which would trade the crash for a silent population change.
 *
 * ⚠️ **Defect 1 is still pinned as TODAY's behaviour, not as correct
 * behaviour.** Making the two routes agree changes enumeration on real corpora
 * in one of two opposite directions (the git route excluding symlinks loses
 * committed content; the walk route including them grows the off-git
 * population), so it is a product decision and does not belong in a drive-by.
 * When it is settled, those assertions flip too, with a changelog entry naming
 * the population change.
 *
 * The 1.1 GB `~/.claude` baseline corpus is the reason this matters in
 * practice: it contains 15 deliberately-dangling `*.md` symlinks and has no
 * `.git`, which is the only reason recording that baseline succeeded — and,
 * now, the reason the same corpus inside a repo produces 15 findings instead
 * of one stack trace.
 */
import { mkdtempSync, rmSync } from 'node:fs';

import { canCreateSymlinks, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  captureEnumerationSnapshot,
  laneById,
  materializeTrapCorpus,
} from '../../src/pipeline-oracles/index.js';

const roots: string[] = [];

/** Assertion message for the fixture prerequisite, not for a VAT behaviour. */
const GIT_INIT_FAILED = 'git init failed — is git on PATH?';

/** The corpus-relative path of the deliberately-dangling symlink. */
const DANGLING = 'symlinks/dangling.md';

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
    expect(gitBuilt.gitInitialized, GIT_INIT_FAILED).toBe(true);

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

describe('a committed dangling *.md symlink is reported, not fatal', () => {
  it('completes the git route and records the unreadable file', async () => {
    const gitRoot = makeRoot('dangling-git');
    const walkRoot = makeRoot('dangling-walk');
    if (!canCreateSymlinks(gitRoot)) {
      console.warn('enumeration-symlink-divergence: symlinks unavailable; the dangling-symlink path was NOT exercised');
      return;
    }
    const gitBuilt = materializeTrapCorpus(gitRoot, { initGit: true, includeDanglingSymlink: true });
    materializeTrapCorpus(walkRoot, { includeDanglingSymlink: true });
    expect(gitBuilt.gitInitialized, GIT_INIT_FAILED).toBe(true);

    const lane = laneById('resources');
    const onGit = await captureEnumerationSnapshot(lane, { corpusRoot: gitRoot, corpus: 'dangling/git' });
    const onWalk = await captureEnumerationSnapshot(lane, { corpusRoot: walkRoot, corpus: 'dangling/walk' });

    // The lane now runs to completion. Before RESOURCE_UNREADABLE it died here
    // with a raw ENOENT: `admitted` was empty and `buildError` matched /ENOENT/.
    expect(onGit.buildError).toBeUndefined();
    expect(onGit.admitted.length).toBeGreaterThan(0);

    // The dangling entry is still ENUMERATED — the git route returns
    // mode-120000 paths — and is simply not ADMITTED. That gap is the
    // population change the finding accounts for, so assert both halves: a fix
    // that made the crawl skip it instead would satisfy "no crash" while
    // silently changing what the corpus is.
    expect(onGit.enumerated.some((row) => row.path === DANGLING && row.symlinkResolves === false)).toBe(
      true,
    );
    expect(onGit.admitted).not.toContain(DANGLING);

    // Unchanged, and still the divergence pinned at the top of this file: the
    // walk route never enumerates the symlink at all, so it has nothing to
    // report. Same tree, same options, different population.
    expect(onWalk.buildError).toBeUndefined();
    expect(onWalk.admitted.length).toBeGreaterThan(0);
    expect(onWalk.enumerated.some((row) => row.path === DANGLING)).toBe(false);
  });

  it('reports RESOURCE_UNREADABLE naming the file, rather than failing silently', async () => {
    const root = makeRoot('dangling-issue');
    if (!canCreateSymlinks(root)) {
      console.warn('enumeration-symlink-divergence: symlinks unavailable; RESOURCE_UNREADABLE was NOT exercised');
      return;
    }
    const built = materializeTrapCorpus(root, { initGit: true, includeDanglingSymlink: true });
    expect(built.gitInitialized, GIT_INIT_FAILED).toBe(true);

    const registry = await laneById('resources').build(root);

    // The raw log first: a caller reconciling enumerated-vs-admitted needs the
    // path, not a rendered message.
    const unreadable = registry.getUnreadableResources();
    expect(unreadable).toHaveLength(1);
    expect(toForwardSlash(unreadable[0]?.filePath ?? '')).toContain(DANGLING);
    expect(unreadable[0]?.code).toBe('ENOENT');

    // Then the finding, which is what a user actually sees. A stderr notice
    // would not count: the report has to carry it.
    const result = await registry.validate();
    const issue = result.issues.find((candidate) => candidate.code === 'RESOURCE_UNREADABLE');
    expect(issue, 'validate() did not report the unreadable file').toBeDefined();
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('dangling.md');
    expect(issue?.message).toMatch(/skipped/i);
  });
});
