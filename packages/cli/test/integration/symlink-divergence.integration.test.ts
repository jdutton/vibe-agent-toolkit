/**
 * The symlink divergence report, over a corpus built to contain every hazard
 * the `followSymlinks` boolean collapses.
 *
 * There is deliberately **no golden here**, following the convention the
 * enumeration goldens already set: creating symlinks needs a privilege Windows
 * CI agents usually lack, so a corpus containing them has two legitimate shapes
 * and no single expected output. What is asserted instead are the properties
 * that must hold on any host that *can* build the corpus — and when the host
 * cannot, this file says so out loud rather than passing silently, because a
 * skipped symlink case reads exactly like a passing one.
 *
 * The real-world motivation, measured rather than imagined: `~/.claude` is not
 * a git repository and 15 of its 16 skill entries are directory symlinks, while
 * Anthropic's own official plugins ship `AGENTS.md ↔ CLAUDE.md` file symlinks —
 * some inside a `.git`, some not. `vat audit` derives a crawl root per skill,
 * so both routes fire inside one run and the same construct is a member in one
 * plugin and absent in the next.
 */
import { mkdtempSync, rmSync } from 'node:fs';

import {
  mkdirSyncReal,
  normalizedTmpdir,
  safePath,
  symlinkCapability,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  captureEnumerationSnapshot,
  captureSymlinkDivergence,
  laneById,
  materializeTrapCorpus,
  renderSymlinkDivergence,
  type EnumerationSnapshot,
  type SymlinkDivergenceReport,
} from '../../src/pipeline-oracles/index.js';

/** Said out loud on every skip: a silent symlink skip reads as a pass. */
const NO_SYMLINKS = 'SKIPPED: host cannot create symlinks (needs Developer Mode on Windows)';

/** The committed file symlink beside its target — the `AGENTS.md ↔ CLAUDE.md` shape. */
const LINK_BESIDE_TARGET = 'symlinks/a/link.md';

/** Held so every test can say why it asserted nothing. */
let symlinksAvailable = false;

/**
 * Build a hazard corpus inside its own subdirectory.
 *
 * The escaping symlink's target is written to the corpus root's PARENT, so the
 * root may never be the temp directory itself.
 *
 * @param label - Suffix for the temp directory name
 * @returns The enclosing temp dir and the corpus root beneath it
 */
function makeHazardCorpus(label: string): { enclosing: string; root: string } {
  const enclosing = mkdtempSync(safePath.join(normalizedTmpdir(), `vat-symlink-${label}-`));
  const root = safePath.join(enclosing, 'corpus');
  mkdirSyncReal(root, { recursive: true });
  return { enclosing, root };
}

describe('symlink divergence — non-git corpus (walk route only)', () => {
  let enclosing: string;
  let report: SymlinkDivergenceReport;

  beforeAll(async () => {
    const made = makeHazardCorpus('nogit');
    enclosing = made.enclosing;
    symlinksAvailable = symlinkCapability() !== null;
    if (!symlinksAvailable) return;

    const built = materializeTrapCorpus(made.root, { includeSymlinkHazards: true });
    expect(built.symlinksCreated).toBe(true);
    report = await captureSymlinkDivergence(laneById('resources'), {
      corpusRoot: made.root,
      corpus: 'trap/hazards-non-git',
    });
  });

  afterAll(() => {
    rmSync(enclosing, { recursive: true, force: true });
  });

  it('bounds a directory loop instead of enumerating it once per kernel-permitted level', () => {
    if (!symlinksAvailable) {
      console.warn(NO_SYMLINKS);
      return;
    }

    // `symlinks/loop/self -> ..` re-enters `symlinks/`. Before crawlDirectory
    // kept a visited-realpath set, following it re-enumerated everything under
    // `symlinks/` once per nesting level, stopping only when the kernel refused
    // further resolution — 32 on macOS, 40 on Linux, so the COUNT was a
    // property of the operating system.
    const repeated = report.rows.filter((row) => row.path.includes('self/'));
    expect(repeated, 'no path may be reached through the loop symlink').toEqual([]);
    expect(report.counts.walkFollow).toBeLessThan(report.counts.walkNoFollow + 10);
  });

  it('classifies the escaping link by where it lands, not by how it looks', () => {
    if (!symlinksAvailable) {
      console.warn(NO_SYMLINKS);
      return;
    }

    const escape = report.rows.find((row) => row.path === 'symlinks/escape.md');
    expect(escape, 'the escaping symlink must appear in the report').toBeDefined();
    expect(escape?.classes).toContain('escapes-root');
    expect(escape?.classes).toContain('follow-only');
    // Its real path is outside the corpus, so it is rendered absolutely — that
    // is the content of the row, and it is why a report captured over a real
    // corpus must be redacted before it is published anywhere.
    expect(escape?.realPath).toContain('outside.md');
  });

  it('names a file reachable under two paths as an alias rather than dropping one', () => {
    if (!symlinksAvailable) {
      console.warn(NO_SYMLINKS);
      return;
    }

    // `symlinks/a/link.md -> target.md`: one blob, two paths, two generated
    // ids. Deduplicating it here would be judgement in phase 1 — the report
    // records the fact and leaves the decision to a consumer.
    const alias = report.rows.find((row) => row.path === LINK_BESIDE_TARGET);
    expect(alias?.classes).toContain('alias');
    expect(alias?.realPath).toBe('symlinks/a/target.md');
  });

  it('renders a report that states its counts even where nothing diverges', () => {
    if (!symlinksAvailable) {
      console.warn(NO_SYMLINKS);
      return;
    }

    const rendered = renderSymlinkDivergence(report);
    expect(rendered).toContain('# symlink-divergence');
    expect(rendered).toContain('inGitRepo: false');
    expect(rendered).toContain('gitRouteCount: -');
    expect(rendered.endsWith('\n')).toBe(true);
  });
});

describe('symlink divergence — git corpus (both routes available)', () => {
  let enclosing: string;
  let report: SymlinkDivergenceReport;
  let snapshot: EnumerationSnapshot;
  let available = false;

  beforeAll(async () => {
    const made = makeHazardCorpus('git');
    enclosing = made.enclosing;
    available = symlinkCapability() !== null;
    if (!available) return;

    const built = materializeTrapCorpus(made.root, { includeSymlinkHazards: true, initGit: true });
    expect(built.gitInitialized, 'git init failed — is git on PATH?').toBe(true);
    report = await captureSymlinkDivergence(laneById('resources'), {
      corpusRoot: made.root,
      corpus: 'trap/hazards-git',
    });
    // The git route returns symlinks regardless of `followSymlinks`, which is
    // what lets one corpus exercise both new enumeration columns without the
    // walk having to follow anything.
    snapshot = await captureEnumerationSnapshot(laneById('resources'), {
      corpusRoot: made.root,
      corpus: 'trap/hazards-git',
    });
  });

  afterAll(() => {
    rmSync(enclosing, { recursive: true, force: true });
  });

  it('shows a committed symlink that the git route returns and the walk drops', () => {
    if (!available) {
      console.warn(NO_SYMLINKS);
      return;
    }

    // This is the shape Anthropic's own plugins ship: a tracked `*.md` symlink
    // beside its target. `git ls-files` hands it back as a mode-120000 entry
    // and nothing filters it; the walk returns early unless following. Same
    // tree, same options, different population — decided only by whether a
    // `.git` exists above the root.
    const gitOnly = report.rows.filter((row) => row.classes.includes('git-only'));
    expect(gitOnly.map((row) => row.path)).toContain(LINK_BESIDE_TARGET);
    expect(report.inGitRepo).toBe(true);
    expect(report.counts.gitRoute).not.toBeNull();
  });

  it('sets the two new enumeration columns to something other than their defaults', () => {
    if (!available) {
      console.warn(NO_SYMLINKS);
      return;
    }

    // ⛔ Both columns are constant-`false` in all ten committed goldens, whose
    // corpora are built with `skipSymlinks: true`. A field that is listed as
    // captured and never observed non-default is a field the gate cannot
    // actually see move — the nominal-not-behavioural failure this suite
    // exists to avoid. This is the only place either column is exercised.
    const row = (path: string) => snapshot.enumerated.find((candidate) => candidate.path === path);

    expect(row(LINK_BESIDE_TARGET)?.aliasesEnumeratedPath, 'a symlink beside its target is an alias').toBe(true);
    expect(row('symlinks/a/target.md')?.aliasesEnumeratedPath, 'the target is equally an alias').toBe(true);
    expect(row('symlinks/escape.md')?.targetInsideRoot, 'the escaping link resolves outside the root').toBe(false);
  });

  it('does not call two files with identical bytes an alias', () => {
    if (!available) {
      console.warn(NO_SYMLINKS);
      return;
    }

    // `twins/left/same.md` and `twins/right/same.md` share a content key — the
    // corpus is built that way deliberately. They are still two files. If
    // aliasing were answered by comparing content keys rather than real paths,
    // this would be true, and every pair of empty files in any corpus would
    // report as aliases of each other.
    const twins = snapshot.enumerated.filter((row) => toForwardSlash(row.path).startsWith('twins/'));
    expect(twins).toHaveLength(2);
    expect(twins[0]?.contentKey).toBe(twins[1]?.contentKey);
    for (const twin of twins) {
      expect(twin.aliasesEnumeratedPath, `${twin.path} is a distinct file, not an alias`).toBe(false);
    }
  });
});
