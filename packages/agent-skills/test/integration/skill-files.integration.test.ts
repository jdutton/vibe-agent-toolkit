/* eslint-disable security/detect-non-literal-fs-filename -- Test code */
import { existsSync, cpSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { countBySeverity, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, runGitOrThrow, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { globSync } from 'glob';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyFilesConfig, mergeFilesConfig } from '../../src/files-config.js';
import { packageSkill, type PackageSkillOptions } from '../../src/skill-packager.js';
import { detectPackagedAgentInstructionFiles } from '../../src/validators/agent-instruction-presence.js';

const FIXTURE_DIR = safePath.join(import.meta.dirname, '..', 'fixtures', 'skill-files');

// Realistic files config: source uses dist/ (gitignored in real projects, simulated by test setup)
const CLI_FILES_ENTRY = [{ source: 'dist/bin/cli.mjs', dest: 'scripts/cli.mjs' }];

// Glob entry: all files under dist/packs/**/* rebased under packs/
const GLOB_FILES_ENTRY = { source: 'dist/packs/**/*', dest: 'packs' };

// Glob-linked file that tool-a's SKILL.md references; asserted preserved across tests.
const ALPHA_DATA_PATH = 'packs/alpha/data.json';

/**
 * Shared test setup: copies post-build fixture to a temp dir, then
 * simulates a project build step by copying the build artifact into
 * dist/bin/ (which would be gitignored in a real project).
 *
 * Writes both a `vibe-agent-toolkit.config.yaml` (so the canonical
 * findProjectRoot anchors to tempDir under the config-first ladder
 * introduced by plan 2026-05-17) and a package.json with "workspaces"
 * (preserved for any test logic that inspects npm-workspace metadata).
 */
function setupSkillFilesTestDir(): { getTempDir: () => string } {
  let tempDir = '';

  beforeAll(async () => {
    tempDir = safePath.join(normalizedTmpdir(), `skill-files-integration-${Date.now()}`);
    await mkdir(tempDir, { recursive: true });
    cpSync(safePath.join(FIXTURE_DIR, 'post-build'), tempDir, { recursive: true });

    // Simulate build step: copy build artifact into dist/ (gitignored in real projects)
    const distBin = safePath.join(tempDir, 'dist', 'bin');
    await mkdir(distBin, { recursive: true });
    cpSync(
      safePath.join(FIXTURE_DIR, 'build-artifacts', 'bin', 'cli.mjs'),
      safePath.join(distBin, 'cli.mjs'),
    );

    // Simulate build step: copy packs artifact tree into dist/packs/ (gitignored in real projects)
    const distPacks = safePath.join(tempDir, 'dist', 'packs');
    await mkdir(distPacks, { recursive: true });
    cpSync(
      safePath.join(FIXTURE_DIR, 'build-artifacts', 'packs'),
      distPacks,
      { recursive: true },
    );

    await writeFile(
      safePath.join(tempDir, 'package.json'),
      JSON.stringify({ name: 'skill-files-test', workspaces: ['skills/*'] }),
    );

    // Anchor canonical findProjectRoot at tempDir (plan 2026-05-17 narrowed
    // findProjectRoot to config-first, no longer consults npm workspaces).
    await writeFile(
      safePath.join(tempDir, 'vibe-agent-toolkit.config.yaml'),
      'version: 1\n',
    );
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  return { getTempDir: () => tempDir };
}

/** Package a skill from the fixture with a unique output dir name */
async function packageFixtureSkill(
  tempDir: string,
  skillName: string,
  outputSuffix: string,
  overrides: Partial<PackageSkillOptions> = {},
) {
  return packageSkill(
    safePath.join(tempDir, 'skills', skillName, 'SKILL.md'),
    {
      outputPath: safePath.join(tempDir, 'out', outputSuffix),
      files: CLI_FILES_ENTRY,
      ...overrides,
    },
  );
}

const { getTempDir } = setupSkillFilesTestDir();

describe('skill files integration', () => {
  it('should copy files config source to dest in packaged output', async () => {
    const result = await packageFixtureSkill(getTempDir(), 'tool-a', 'copy-test');
    expect(existsSync(safePath.join(result.outputPath, 'scripts', 'cli.mjs'))).toBe(true);
  });

  it('should route auto-discovered .mjs to scripts/', async () => {
    const result = await packageFixtureSkill(getTempDir(), 'tool-a', 'routing-test');
    expect(existsSync(safePath.join(result.outputPath, 'scripts', 'helper.mjs'))).toBe(true);
  });

  it('should keep .md resources in resources/', async () => {
    const result = await packageFixtureSkill(getTempDir(), 'tool-a', 'md-test');
    expect(existsSync(safePath.join(result.outputPath, 'resources', 'guide.md'))).toBe(true);
  });

  it('should fail build when files source does not exist', async () => {
    await expect(
      packageFixtureSkill(getTempDir(), 'tool-b', 'missing-test', {
        linkFollowDepth: 0,
        files: [{ source: 'nonexistent/cli.mjs', dest: 'scripts/cli.mjs' }],
      })
    ).rejects.toThrow(/does not exist/i);
  });

  it('should handle same build artifact in multiple skills', async () => {
    const tempDir = getTempDir();
    const resultA = await packageFixtureSkill(tempDir, 'tool-a', 'multi-a');
    const resultB = await packageFixtureSkill(tempDir, 'tool-b', 'multi-b', { linkFollowDepth: 0 });

    expect(existsSync(safePath.join(resultA.outputPath, 'scripts', 'cli.mjs'))).toBe(true);
    expect(existsSync(safePath.join(resultB.outputPath, 'scripts', 'cli.mjs'))).toBe(true);
  });
});

describe('glob files entry integration', () => {
  /**
   * Package tool-a with both the CLI single-file entry and the glob packs entry.
   * tool-a's SKILL.md links to packs/alpha/data.json, which should be preserved.
   */
  it('should rebase glob-matched files under dest dir in packaged output', async () => {
    const tempDir = getTempDir();
    const result = await packageFixtureSkill(tempDir, 'tool-a', 'glob-tree-test', {
      files: [...CLI_FILES_ENTRY, GLOB_FILES_ENTRY],
    });

    // Rebased tree: both alpha and beta files appear under packs/
    expect(existsSync(safePath.join(result.outputPath, 'packs', 'alpha', 'data.json'))).toBe(true);
    expect(existsSync(safePath.join(result.outputPath, 'packs', 'beta', 'data.json'))).toBe(true);
  });

  it('should preserve content of glob-copied files byte-for-byte', async () => {
    const tempDir = getTempDir();
    const result = await packageFixtureSkill(tempDir, 'tool-a', 'glob-content-test', {
      files: [...CLI_FILES_ENTRY, GLOB_FILES_ENTRY],
    });

    const srcAlpha = readFileSync(safePath.join(tempDir, 'dist', 'packs', 'alpha', 'data.json'), 'utf-8');
    const dstAlpha = readFileSync(safePath.join(result.outputPath, 'packs', 'alpha', 'data.json'), 'utf-8');
    expect(dstAlpha).toBe(srcAlpha);

    const srcBeta = readFileSync(safePath.join(tempDir, 'dist', 'packs', 'beta', 'data.json'), 'utf-8');
    const dstBeta = readFileSync(safePath.join(result.outputPath, 'packs', 'beta', 'data.json'), 'utf-8');
    expect(dstBeta).toBe(srcBeta);
  });

  it('should preserve link to glob-dest file in packaged SKILL.md (not stripped to ())', async () => {
    const tempDir = getTempDir();
    const result = await packageFixtureSkill(tempDir, 'tool-a', 'glob-link-test', {
      files: [...CLI_FILES_ENTRY, GLOB_FILES_ENTRY],
    });

    const packedSkill = readFileSync(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    // The link to packs/alpha/data.json must NOT be stripped to ()
    expect(packedSkill).not.toContain('()\n');
    expect(packedSkill).toContain(ALPHA_DATA_PATH);
  });

  it('should not emit PACKAGED_UNREFERENCED issue for glob-linked file', async () => {
    const tempDir = getTempDir();
    const result = await packageFixtureSkill(tempDir, 'tool-a', 'glob-no-unreferenced-test', {
      files: [...CLI_FILES_ENTRY, GLOB_FILES_ENTRY],
    });

    // Sanity: the link IS genuinely preserved (so the assertion below passes for
    // the RIGHT reason — not because the array happens to be empty/undefined).
    const packedSkill = readFileSync(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
    expect(packedSkill).toContain(ALPHA_DATA_PATH);

    // No post-build issue flagging packs/alpha/data.json as unreferenced or broken.
    // For PACKAGED_UNREFERENCED_FILE the path lives in `location`; for
    // PACKAGED_BROKEN_LINK the source file is in `location` and the href in `message`.
    // Check both fields so either shape is caught.
    const issues = result.postBuildIssues ?? [];
    const unreferencedIssues = issues.filter((issue: ValidationIssue) =>
      (issue.code === 'PACKAGED_UNREFERENCED_FILE' || issue.code === 'PACKAGED_BROKEN_LINK') &&
      (toForwardSlash(issue.location ?? '').includes(ALPHA_DATA_PATH) ||
        toForwardSlash(issue.message).includes(ALPHA_DATA_PATH))
    );
    expect(unreferencedIssues).toHaveLength(0);
  });

  /**
   * Direct-primitive coverage for the `files:` glob expansion: mergeFilesConfig +
   * applyFilesConfig, exercised without going through skill-packager. Plugin-local
   * skills now route through `packageSkill` like every other skill (the old
   * verbatim tree-copy path and its `applyTreeCopiedSkillFiles` re-application are
   * gone), so this asserts the shared primitive rather than a second build path.
   */
  it('should rebase glob tree via applyFilesConfig (plugin-build path simulation)', async () => {
    const tempDir = getTempDir();

    // Simulate what build.ts does: mergeFilesConfig then applyFilesConfig
    const filesConfig = mergeFilesConfig(undefined, [GLOB_FILES_ENTRY]);
    const skillOutputDir = safePath.join(tempDir, 'out', 'plugin-build-sim', 'skills', 'tool-a');
    await mkdir(skillOutputDir, { recursive: true });

    const { dests } = await applyFilesConfig({
      filesConfig,
      projectRoot: tempDir,
      skillOutputDir,
    });

    // Should have copied both packs files
    expect(dests).toContain(toForwardSlash('packs/alpha/data.json'));
    expect(dests).toContain(toForwardSlash('packs/beta/data.json'));

    // Files must exist at the rebased dest paths
    expect(existsSync(safePath.join(skillOutputDir, 'packs', 'alpha', 'data.json'))).toBe(true);
    expect(existsSync(safePath.join(skillOutputDir, 'packs', 'beta', 'data.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// End-to-end coverage for the link-bundled GLOB `files:` entry (commit d648fdd3).
// ---------------------------------------------------------------------------

const LINKED_GLOB_SOURCE = 'gen/packs/**/*';
const LINKED_GLOB_DEST = 'packs';
const GUIDE_SOURCE_REL = 'gen/packs/alpha/GUIDE.md';
/** Declared dest of the link-bundled match, as output-relative path segments. */
const GUIDE_DEST_SEGMENTS = [LINKED_GLOB_DEST, 'alpha', 'GUIDE.md'] as const;
/** Declared dest of the sibling that link traversal never touched. */
const DATA_DEST_SEGMENTS = [LINKED_GLOB_DEST, 'alpha', 'data.json'] as const;
/**
 * Where link traversal WOULD park its own copy of the guide (basename naming) if
 * the declared `dest:` did not own the answer. Asserted ABSENT: one file, one dest.
 */
const GUIDE_TRAVERSAL_DEST = 'resources/GUIDE.md';
const GUIDE_BYTES = '# Alpha Pack Guide\n\nHow to drive the alpha pack.\n';
const PACK_DATA_BYTES = '{"pack":"alpha"}\n';

/** A repo-internal agent-instruction file an explicit `files:` entry declares. */
const NOTES_CLAUDE_SOURCE = 'notes/CLAUDE.md';
const NOTES_CLAUDE_DEST = 'notes/CLAUDE.md';
const NOTES_CLAUDE_BYTES = '# Repo notes\n\nHow this repository is organised.\n';

/** SKILL.md that links the declared agent-instruction file by its SOURCE path. */
const DECLARER_SKILL = `---
name: declarer
description: Declares a repo-internal agent-instruction file and links to it
---

# Declarer

See the [repo notes](../../notes/CLAUDE.md).
`;

/** SKILL.md that links the glob-matched guide by its SOURCE path. */
const LINKING_SKILL = `---
name: packer
description: Ships a generated pack tree and documents it inline
---

# Packer

See the [alpha pack guide](../../gen/packs/alpha/GUIDE.md) before editing a pack.
`;

/** Control SKILL.md: same build, same entry, no link to the glob-matched guide. */
const UNLINKED_SKILL = `---
name: packer-control
description: Ships the same generated pack tree without linking into it
---

# Packer Control

No link into the generated pack tree.
`;

interface LinkedGlobRepo {
  getRepoRoot: () => string;
}

/**
 * Build a REAL git repository whose `gen/packs/alpha/` tree is both matched by a
 * glob `files:` entry and linked from SKILL.md by its SOURCE path.
 *
 * `git init` + `.gitignore` + a commit are deliberate. `createProjectRegistry`
 * answers a crawl with `git ls-files` whenever the base is inside a repo, and
 * the walker's gitignore rule only has an opinion when a repo exists; a bare
 * `mkdtemp` tree takes the manual-walk fallback and silently disables both, so
 * it is not the system adopters run. (The suite above is such a repo-less
 * fixture.) Measured here: with the repo, the crawl sees exactly the committed
 * source tree; without it, the crawl also swallows every previous test's output
 * under the gitignored `out/` — same verdicts on these rows, 3x the runtime, and
 * a registry population no adopter would ever have.
 */
function setupLinkedGlobRepo(): LinkedGlobRepo {
  let repoRoot = '';

  beforeAll(async () => {
    repoRoot = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-linked-glob-'));

    await mkdir(safePath.join(repoRoot, 'gen', 'packs', 'alpha'), { recursive: true });
    await writeFile(safePath.join(repoRoot, 'gen', 'packs', 'alpha', 'GUIDE.md'), GUIDE_BYTES);
    await writeFile(safePath.join(repoRoot, 'gen', 'packs', 'alpha', 'data.json'), PACK_DATA_BYTES);

    await mkdir(safePath.join(repoRoot, 'notes'), { recursive: true });
    await writeFile(safePath.join(repoRoot, NOTES_CLAUDE_SOURCE), NOTES_CLAUDE_BYTES);
    // A second file under notes/ so the glob negative-control below still has
    // something to keep — a glob whose every match is never-packaged is a
    // hard error in copyGlobEntry, which would mask the row's real subject.
    await writeFile(safePath.join(repoRoot, 'notes', 'reference.md'), '# Reference\n');

    for (const [dir, body] of [
      ['packer', LINKING_SKILL],
      ['control', UNLINKED_SKILL],
      ['declarer', DECLARER_SKILL],
    ] as const) {
      await mkdir(safePath.join(repoRoot, 'skills', dir), { recursive: true });
      await writeFile(safePath.join(repoRoot, 'skills', dir, 'SKILL.md'), body);
    }

    await writeFile(safePath.join(repoRoot, '.gitignore'), 'out/\nnode_modules/\n');
    await writeFile(safePath.join(repoRoot, 'vibe-agent-toolkit.config.yaml'), 'version: 1\n');
    await writeFile(
      safePath.join(repoRoot, 'package.json'),
      JSON.stringify({ name: 'linked-glob-fixture', private: true }),
    );

    runGitOrThrow(['init', '-q', '-b', 'main'], { cwd: repoRoot });
    runGitOrThrow(['add', '-A'], { cwd: repoRoot });
    runGitOrThrow(['-c', 'user.email=vat@example.test', '-c', 'user.name=VAT Fixture',
        'commit', '-q', '-m', 'fixture tree'],
      { cwd: repoRoot },
    );
  });

  afterAll(async () => {
    if (repoRoot) {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  return { getRepoRoot: () => repoRoot };
}

/** Package one fixture skill with the given `files:` entries. */
async function packageLinkedGlobSkill(
  repoRoot: string,
  skillDir: string,
  outputSuffix: string,
  files: PackageSkillOptions['files'],
) {
  return packageSkill(safePath.join(repoRoot, 'skills', skillDir, 'SKILL.md'), {
    outputPath: safePath.join(repoRoot, 'out', outputSuffix),
    files,
  });
}

/** Sorted rel paths of every file under `dir`, for whole-subtree comparisons. */
function subtreeContents(dir: string): string[] {
  return globSync('**/*', { cwd: dir, nodir: true, dot: true })
    .map(toForwardSlash)
    .sort((a, b) => a.localeCompare(b));
}

const { getRepoRoot } = setupLinkedGlobRepo();

describe.each([
  { label: 'plain', integrity: false },
  { label: 'integrity: true', integrity: true },
])(
  'glob files: entry whose match is also link-bundled ($label)',
  ({ label, integrity }) => {
    const suffix = `linked-glob-${label.replaceAll(/[^a-z]+/gi, '-')}`;
    const entry = integrity
      ? { source: LINKED_GLOB_SOURCE, dest: LINKED_GLOB_DEST, integrity: true }
      : { source: LINKED_GLOB_SOURCE, dest: LINKED_GLOB_DEST };

    it('ships the whole declared dest subtree, including the link-bundled match', async () => {
      const repoRoot = getRepoRoot();
      const result = await packageLinkedGlobSkill(repoRoot, 'packer', suffix, [entry]);

      // PRECONDITION — this is what makes the row a regression test at all: link
      // traversal really did bundle the glob-matched guide, so the pre-d648fdd3
      // `if (bundledFileSet.has(absSource)) continue;` in copyGlobEntry fired on it.
      expect(result.files.dependencies.map(toForwardSlash)).toContain(GUIDE_SOURCE_REL);

      // DISCRIMINATOR — pre-fix this file was skipped before its dest was even
      // computed, so the declared subtree shipped short and the build exited 0.
      const guideDest = safePath.join(result.outputPath, ...GUIDE_DEST_SEGMENTS);
      expect(existsSync(guideDest)).toBe(true);
      expect(readFileSync(guideDest, 'utf-8')).toBe(GUIDE_BYTES);

      // The un-bundled sibling was never at risk; assert it so a subtree that
      // ships nothing at all can't pass the row.
      const dataDest = safePath.join(result.outputPath, ...DATA_DEST_SEGMENTS);
      expect(readFileSync(dataDest, 'utf-8')).toBe(PACK_DATA_BYTES);

      expect(result.hasErrors).toBe(false);
    });

    it('ships the same dest subtree as the control build with no link into it', async () => {
      const repoRoot = getRepoRoot();
      const linked = await packageLinkedGlobSkill(repoRoot, 'packer', `${suffix}-a`, [entry]);
      const control = await packageLinkedGlobSkill(repoRoot, 'control', `${suffix}-b`, [entry]);

      // Whether a SKILL.md happens to link a matched file is an authoring choice
      // about prose, not a packaging instruction — the payload must be identical.
      expect(subtreeContents(safePath.join(linked.outputPath, LINKED_GLOB_DEST)))
        .toEqual(subtreeContents(safePath.join(control.outputPath, LINKED_GLOB_DEST)));
      expect(subtreeContents(safePath.join(linked.outputPath, LINKED_GLOB_DEST)))
        .toEqual(['alpha/data.json', 'alpha/GUIDE.md']);

      // ONE FILE, ONE DEST. Link traversal used to park a SECOND copy of the guide
      // at its type-derived location while the glob copied it to the declared dest:
      // identical bytes shipped twice, the declared `dest:` dead as far as the
      // rewritten link was concerned, and nothing reported the duplication. The
      // declared dest is the only answer, so linking a matched file must not change
      // the payload AT ALL — not just the declared subtree.
      expect(subtreeContents(linked.outputPath)).not.toContain(GUIDE_TRAVERSAL_DEST);
      expect(subtreeContents(linked.outputPath)).toEqual(subtreeContents(control.outputPath));
    });

    it('rewrites the link to the declared dest, not to a traversal-named copy', async () => {
      const repoRoot = getRepoRoot();
      const result = await packageLinkedGlobSkill(repoRoot, 'packer', `${suffix}-link`, [entry]);

      const packedSkill = readFileSync(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8');
      expect(packedSkill).toContain(`(${GUIDE_DEST_SEGMENTS.join('/')})`);
      // The dead end the duplicate copy used to make the link point at.
      expect(packedSkill).not.toContain(GUIDE_TRAVERSAL_DEST);
    });
  },
);

// ---------------------------------------------------------------------------
// The EXPLICIT `files:` declaration as the working escape hatch for a link to a
// repo-internal agent-instruction file (LINK_TO_AGENT_INSTRUCTION_FILE).
//
// The code's own remediation told authors to declare the file under
// `skills.config.<name>.files`. Doing exactly that used to change nothing: the
// walker refused the LINK regardless of config, so the build shipped the file,
// stripped the link to it, and still exited 1 with the same error prescribing the
// same already-taken action.
// ---------------------------------------------------------------------------

describe('explicit files: entry naming an agent-instruction file', () => {
  const DECLARED = [{ source: NOTES_CLAUDE_SOURCE, dest: NOTES_CLAUDE_DEST }];

  it('does not report LINK_TO_AGENT_INSTRUCTION_FILE for the declared file', async () => {
    const result = await packageLinkedGlobSkill(getRepoRoot(), 'declarer', 'declared-ai', DECLARED);

    const codes = (result.postBuildIssues ?? []).map((i) => i.code);
    expect(codes).not.toContain('LINK_TO_AGENT_INSTRUCTION_FILE');
  });

  it('ships the file exactly once, at the declared dest', async () => {
    const result = await packageLinkedGlobSkill(getRepoRoot(), 'declarer', 'declared-ai-once', DECLARED);

    // Any CLAUDE.md in the output, wherever it landed — so a second copy under a
    // traversal-named directory fails the row instead of hiding behind an
    // existsSync on the one path we expected.
    expect(subtreeContents(result.outputPath).filter((p) => p.endsWith('CLAUDE.md')))
      .toEqual([NOTES_CLAUDE_DEST]);
    expect(readFileSync(safePath.join(result.outputPath, NOTES_CLAUDE_DEST), 'utf-8'))
      .toBe(NOTES_CLAUDE_BYTES);
  });

  it('rewrites the link to the declared dest instead of stripping it', async () => {
    const result = await packageLinkedGlobSkill(getRepoRoot(), 'declarer', 'declared-ai-link', DECLARED);

    // Suppressing the error while leaving the link de-linked would trade a loud,
    // true error for a silent, false success — the whole point of the fix is that
    // the declared file is REACHABLE from the packaged prose.
    expect(readFileSync(safePath.join(result.outputPath, 'SKILL.md'), 'utf-8'))
      .toContain(`(${NOTES_CLAUDE_DEST})`);
  });

  it('still reports the link when only a GLOB catches the file', async () => {
    // A glob is a net, not a declaration: it never named the file, so it must not
    // launder the exemption an explicit entry earns. `gen/packs/**/*` is used as
    // the co-declared entry so the build still has something to copy.
    const result = await packageLinkedGlobSkill(getRepoRoot(), 'declarer', 'declared-ai-glob', [
      { source: 'notes/**/*', dest: 'notes' },
      { source: LINKED_GLOB_SOURCE, dest: LINKED_GLOB_DEST },
    ]);

    const codes = (result.postBuildIssues ?? []).map((i) => i.code);
    expect(codes).toContain('LINK_TO_AGENT_INSTRUCTION_FILE');
    expect(subtreeContents(result.outputPath).filter((p) => p.endsWith('CLAUDE.md'))).toEqual([]);
  });
});

describe('glob files: integrity accounts for the whole config, in any order', () => {
  /**
   * A sibling `files:` entry writing into the glob entry's dest subtree is a
   * DECLARATION, not contamination — it is how the documented escape hatch ships a
   * file the glob's never-package filter drops. `verifyDestSet` used to reject it,
   * and only when the sibling was listed FIRST: listed second it wrote after the
   * check had already run, so the same config passed. Same payload, opposite
   * verdicts, decided by entry order.
   *
   * Both orders are asserted because either alone is satisfiable by re-sorting the
   * entries rather than by making the check order-independent. Liveness — a file
   * under the subtree that NO entry declares still throws — is proven at the unit
   * level (files-config.test.ts, 'still rejects a file under the dest subtree that
   * no entry declares'), where a stray can be planted; a real build wipes the
   * output dir first, so there is nothing to plant here.
   */
  it.each([
    { label: 'sibling entry first', siblingFirst: true },
    { label: 'glob entry first', siblingFirst: false },
  ])('accepts a sibling entry\'s declared dest inside the subtree ($label)', async ({ siblingFirst, label }) => {
    const repoRoot = getRepoRoot();
    const sibling = { source: GUIDE_SOURCE_REL, dest: 'packs/alpha/EXTRA.md' };
    const globEntry = { source: LINKED_GLOB_SOURCE, dest: LINKED_GLOB_DEST, integrity: true };
    const suffix = `linked-glob-order-${label.replaceAll(/[^a-z]+/gi, '-')}`;

    const result = await packageLinkedGlobSkill(
      repoRoot,
      'packer',
      suffix,
      siblingFirst ? [sibling, globEntry] : [globEntry, sibling],
    );

    expect(subtreeContents(safePath.join(result.outputPath, LINKED_GLOB_DEST))).toEqual([
      'alpha/data.json',
      'alpha/EXTRA.md',
      'alpha/GUIDE.md',
    ]);
  });
});

// ---------------------------------------------------------------------------
// FIX 2: a file the never-package filter drops must be visible in the STRUCTURED
// result, not only on stderr. `postBuildIssues` is the channel the build report's
// `issueCounts` is derived from (see collectPostBuildIssues in the CLI), so a drop
// that never becomes a ValidationIssue reads as `warnings: 0` to a CI consumer for
// a build that shipped less than the config declared.
//
// Deliberately routed through the REAL packageSkill, not through a hand-injected
// callback: a unit test that supplies its own sink proves only that the sink is
// called. Measured blind spot before this test existed — deleting the packager's
// reporting line left 1522 unit + 145 integration tests green.
// ---------------------------------------------------------------------------

const EXTRAS_GLOB_ENTRY = { source: 'dist/extras/**/*', dest: 'extras' };
const DROPPED_BASENAMES = ['CLAUDE.md', 'README.md'] as const;

describe('never-packaged glob matches reach the structured build result', () => {
  beforeAll(async () => {
    const extras = safePath.join(getTempDir(), 'dist', 'extras');
    await mkdir(extras, { recursive: true });
    for (const name of DROPPED_BASENAMES) {
      await writeFile(safePath.join(extras, name), `# ${name}\n`);
    }
    await writeFile(safePath.join(extras, 'data.json'), '{"ok":true}\n');
  });

  it('emits one warning-severity issue per dropped file', async () => {
    const result = await packageFixtureSkill(getTempDir(), 'tool-a', 'never-package-report', {
      files: [...CLI_FILES_ENTRY, EXTRAS_GLOB_ENTRY],
    });

    // PRECONDITION — the drop really happened in this build, so the assertion
    // below cannot pass by the glob having quietly matched nothing.
    expect(existsSync(safePath.join(result.outputPath, 'extras', 'data.json'))).toBe(true);
    for (const name of DROPPED_BASENAMES) {
      expect(existsSync(safePath.join(result.outputPath, 'extras', name))).toBe(false);
    }

    const issues = result.postBuildIssues ?? [];
    const drops = issues.filter(i => i.code === 'FILES_GLOB_DROPPED_NEVER_PACKAGED');
    // Anchored at the SOURCE file (`dist/extras/…`), not the dest subtree
    // (`extras/…`) the entry would have rebased it into: the dest was never
    // written, so it names a path that exists in no tree. The two spellings
    // differ here on purpose — that is what makes this assertion able to tell
    // them apart.
    expect(drops.map(i => i.location).sort((a, b) => (a ?? '').localeCompare(b ?? ''))).toEqual(
      DROPPED_BASENAMES.map(n => `dist/extras/${n}`).sort((a, b) => a.localeCompare(b)),
    );
    // The count the report publishes — derived the same way the CLI derives it.
    expect(countBySeverity(issues).warnings).toBeGreaterThanOrEqual(DROPPED_BASENAMES.length);
    for (const drop of drops) {
      expect(drop.severity).toBe('warning');
      expect(drop.message).toContain(EXTRAS_GLOB_ENTRY.source);
    }
  });
});

// ---------------------------------------------------------------------------
// §8.2 precedence at BUILD time: an explicit `files:` entry naming an
// agent-instruction dest expresses intent, and the build must follow it.
//
// Before this, `packageSkill` warned PACKAGED_AGENT_INSTRUCTION_FILE for exactly
// the config the guide prescribes as the escape hatch — with a remedy ("remove
// the file") that told the author to undo what config had sanctioned.
// ---------------------------------------------------------------------------

const AGENT_INSTRUCTION_CODE = 'PACKAGED_AGENT_INSTRUCTION_FILE';
/** The same declared dest the escape-hatch cases above use, sourced from dist/. */
const DIST_NOTES_CLAUDE_ENTRY = { source: `dist/${NOTES_CLAUDE_DEST}`, dest: NOTES_CLAUDE_DEST };

describe('explicit files: dest suppresses PACKAGED_AGENT_INSTRUCTION_FILE', () => {

  beforeAll(async () => {
    const notes = safePath.join(getTempDir(), 'dist', 'notes');
    await mkdir(notes, { recursive: true });
    await writeFile(safePath.join(notes, 'CLAUDE.md'), '# deliberately shipped guidance\n');
  });

  it('does not report a CLAUDE.md an explicit entry named', async () => {
    const result = await packageFixtureSkill(getTempDir(), 'tool-a', 'explicit-claude-md', {
      files: [...CLI_FILES_ENTRY, DIST_NOTES_CLAUDE_ENTRY],
    });

    // PRECONDITION — the file really is in the bundle, so a green assertion below
    // cannot be produced by the copy having silently not happened.
    expect(existsSync(safePath.join(result.outputPath, 'notes', 'CLAUDE.md'))).toBe(true);

    const issues = result.postBuildIssues ?? [];
    expect(issues.filter(i => i.code === AGENT_INSTRUCTION_CODE)).toEqual([]);
  });

  it('still reports one that no entry declared', async () => {
    // Same build shape, but the file arrives at a dest the config never named —
    // the suppression must not spill onto the rest of the bundle.
    const result = await packageFixtureSkill(getTempDir(), 'tool-a', 'undeclared-claude-md', {
      files: [...CLI_FILES_ENTRY, DIST_NOTES_CLAUDE_ENTRY],
    });
    await writeFile(safePath.join(result.outputPath, 'AGENTS.md'), '# smuggled\n');

    const issues = detectPackagedAgentInstructionFiles(
      result.outputPath,
      result.outputPath,
      [NOTES_CLAUDE_DEST],
    );
    expect(issues.map(i => i.location)).toEqual(['AGENTS.md']);
  });
});
