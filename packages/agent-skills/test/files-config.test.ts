/* eslint-disable security/detect-non-literal-fs-filename -- test sandbox paths derived from tmp dirs */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyFilesConfig,
  buildArtifactHint,
  collectDroppedGlobMatches,
  explicitFilesConfigDests,
  globEntryDest,
  mergeFilesConfig,
  verifyFilesIntegrity,
  verifyDestSet,
  type SkillFileEntry,
} from '../src/files-config.js';

const CLI_SOURCE = 'dist/bin/cli.mjs';
const CLI_DEST = 'scripts/cli.mjs';
const GLOB_PACKS_SOURCE = 'dist/packs/**/*';
const GLOB_PACKS_DEST = 'packs';
const BUILD_ARTIFACT_FRAGMENT = 'build artifact';

/** Tmp dirs created by applyFilesConfig tests, cleaned up after each. */
const APPLY_TMP_DIRS: string[] = [];
/** Shared filenames/dests used across applyFilesConfig cases. */
const DATA_FILE = 'data.json';
const DATA_DEST = `data/${DATA_FILE}`;
const DATA_SOURCE = `dist/gen/${DATA_FILE}`;
/** Canonical bytes written to the build-artifact source (shared across cases). */
const DATA_BYTES = '{"ok":true}';

/** Create an isolated {projectRoot, skillOutputDir} sandbox with a build artifact source. */
function makeApplySandbox(): { projectRoot: string; skillOutputDir: string } {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-apply-files-'));
  APPLY_TMP_DIRS.push(root);
  const projectRoot = safePath.join(root, 'project');
  const skillOutputDir = safePath.join(root, 'out');
  mkdirSyncReal(safePath.join(projectRoot, 'dist', 'gen'), { recursive: true });
  mkdirSyncReal(skillOutputDir, { recursive: true });
  writeFileSync(safePath.join(projectRoot, 'dist', 'gen', DATA_FILE), DATA_BYTES);
  return { projectRoot, skillOutputDir };
}

/**
 * Shared shape for the "glob entry whose matched source is also link-bundled" cases.
 *
 * Source tree: `<projectRoot>/gen/packs/alpha/{GUIDE.md,data.json}`, shipped by the
 * glob entry `gen/packs/**\/*` → dest `packs`. `GUIDE.md` stands in for a matched
 * file that SKILL.md also links by its SOURCE path, so link traversal bundled it
 * and its absolute source path arrives in `bundledFiles`.
 *
 * No `git init` here on purpose: `applyFilesConfig` never crawls a directory and
 * never consults gitignore — it resolves the declared source/dest paths and expands
 * the glob directly. There is no gitignore-dependent branch for a repo-less fixture
 * to silently disable.
 */
const PACK_GLOB_SOURCE = 'gen/packs/**/*';
const PACK_GLOB_DEST = 'packs';
const PACK_GUIDE_BYTES = '# Guide\n\nPack usage guide body.\n';
const PACK_DATA_BYTES = '{"pack":"alpha"}\n';

interface PackGlobSandbox {
  projectRoot: string;
  skillOutputDir: string;
  /** Absolute path of the link-bundled matched source (goes into `bundledFiles`). */
  bundledGuideSource: string;
  /** Skill-output-relative dest the glob entry declares for the bundled guide. */
  guideDest: string;
  /** Skill-output-relative dest the glob entry declares for the un-bundled sibling. */
  dataDest: string;
}

function makePackGlobSandbox(): PackGlobSandbox {
  const { projectRoot, skillOutputDir } = makeApplySandbox();
  const packDir = safePath.join(projectRoot, 'gen', 'packs', 'alpha');
  mkdirSyncReal(packDir, { recursive: true });
  writeFileSync(safePath.join(packDir, 'GUIDE.md'), PACK_GUIDE_BYTES);
  writeFileSync(safePath.join(packDir, 'data.json'), PACK_DATA_BYTES);
  return {
    projectRoot,
    skillOutputDir,
    bundledGuideSource: safePath.resolve(safePath.join(packDir, 'GUIDE.md')),
    guideDest: toForwardSlash(safePath.join(PACK_GLOB_DEST, 'alpha', 'GUIDE.md')),
    dataDest: toForwardSlash(safePath.join(PACK_GLOB_DEST, 'alpha', 'data.json')),
  };
}

describe('mergeFilesConfig', () => {
  it('should return empty array when no defaults and no per-skill', () => {
    expect(mergeFilesConfig(undefined, undefined)).toEqual([]);
  });

  it('should return defaults when no per-skill files', () => {
    const defaults: SkillFileEntry[] = [
      { source: CLI_SOURCE, dest: CLI_DEST },
    ];
    expect(mergeFilesConfig(defaults, undefined)).toEqual(defaults);
  });

  it('should return per-skill when no defaults', () => {
    const perSkill: SkillFileEntry[] = [
      { source: 'dist/bin/tool.mjs', dest: 'scripts/tool.mjs' },
    ];
    expect(mergeFilesConfig(undefined, perSkill)).toEqual(perSkill);
  });

  it('should combine defaults and per-skill when no overlap', () => {
    const defaults: SkillFileEntry[] = [
      { source: 'dist/bin/shared.mjs', dest: 'scripts/shared.mjs' },
    ];
    const perSkill: SkillFileEntry[] = [
      { source: 'dist/bin/tool.mjs', dest: 'scripts/tool.mjs' },
    ];
    const result = mergeFilesConfig(defaults, perSkill);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual(defaults[0]);
    expect(result).toContainEqual(perSkill[0]);
  });

  it('should let per-skill override defaults when dest matches', () => {
    const defaults: SkillFileEntry[] = [
      { source: 'dist/bin/v1.mjs', dest: CLI_DEST },
    ];
    const perSkill: SkillFileEntry[] = [
      { source: 'dist/bin/v2.mjs', dest: CLI_DEST },
    ];
    const result = mergeFilesConfig(defaults, perSkill);
    expect(result).toHaveLength(1);
    expect(result[0]?.source).toBe('dist/bin/v2.mjs');
  });

  it('should detect duplicate dest within same level and throw', () => {
    const perSkill: SkillFileEntry[] = [
      { source: 'dist/a.mjs', dest: CLI_DEST },
      { source: 'dist/b.mjs', dest: CLI_DEST },
    ];
    expect(() => mergeFilesConfig(undefined, perSkill)).toThrow(/duplicate.*dest/i);
  });

  it('should handle empty per-skill array (inherits defaults)', () => {
    const defaults: SkillFileEntry[] = [
      { source: 'dist/bin/shared.mjs', dest: 'scripts/shared.mjs' },
    ];
    const result = mergeFilesConfig(defaults, []);
    expect(result).toEqual(defaults);
  });
});

describe('explicitFilesConfigDests', () => {
  it('returns the dests of non-glob entries only', () => {
    // A glob is a net, not a declaration — it never named the file it caught, so
    // its expansion must not earn the exemption an explicit entry earns.
    const files: SkillFileEntry[] = [
      { source: CLI_SOURCE, dest: CLI_DEST },
      { source: GLOB_PACKS_SOURCE, dest: GLOB_PACKS_DEST },
    ];
    expect(explicitFilesConfigDests(files)).toEqual([CLI_DEST]);
  });

  it('normalizes the spelling so it compares equal to a packaged rel path', () => {
    expect(explicitFilesConfigDests([{ source: 'a/b.md', dest: './notes/CLAUDE.md' }]))
      .toEqual(['notes/CLAUDE.md']);
  });

  it('returns an empty list for no entries', () => {
    expect(explicitFilesConfigDests([])).toEqual([]);
  });
});

/** Sandbox with `<projectRoot>/extras/{keep.json,README.md,CLAUDE.md}`. */
function makeExtrasSandbox(): string {
  const { projectRoot } = makeApplySandbox();
  const extras = safePath.join(projectRoot, EXTRAS_DEST);
  mkdirSyncReal(extras, { recursive: true });
  writeFileSync(safePath.join(extras, 'keep.json'), '{}');
  writeFileSync(safePath.join(extras, 'README.md'), '# readme\n');
  writeFileSync(safePath.join(extras, 'CLAUDE.md'), '# guidance\n');
  return projectRoot;
}

const EXTRAS_DEST = 'extras';
const EXTRAS_GLOB_SOURCE = 'extras/**/*';
const EXTRAS_README_DEST = 'extras/README.md';
const EXTRAS_CLAUDE_DEST = 'extras/CLAUDE.md';
const extrasGlob: SkillFileEntry = { source: EXTRAS_GLOB_SOURCE, dest: EXTRAS_DEST };

describe('collectDroppedGlobMatches', () => {
  afterEach(() => {
    for (const dir of APPLY_TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('reports each never-packaged file a glob matched, spelled as its would-be dest', async () => {
    const projectRoot = makeExtrasSandbox();
    const dropped = await collectDroppedGlobMatches([extrasGlob], projectRoot);
    expect(dropped.map(d => d.dest).sort((a, b) => a.localeCompare(b)))
      .toEqual([EXTRAS_CLAUDE_DEST, EXTRAS_README_DEST]);
    expect(dropped.every(d => d.source === EXTRAS_GLOB_SOURCE)).toBe(true);
  });

  it('does not report a drop an explicit entry re-ships (the documented escape hatch)', async () => {
    const projectRoot = makeExtrasSandbox();
    const dropped = await collectDroppedGlobMatches(
      [extrasGlob, { source: EXTRAS_README_DEST, dest: EXTRAS_README_DEST }],
      projectRoot,
    );
    // Order-independent: the filter is on the FINAL declared dest set, not on the
    // order the two entries were written.
    expect(dropped.map(d => d.dest)).toEqual([EXTRAS_CLAUDE_DEST]);
  });

  it('ignores non-glob entries entirely', async () => {
    const projectRoot = makeExtrasSandbox();
    const dropped = await collectDroppedGlobMatches(
      [{ source: EXTRAS_CLAUDE_DEST, dest: 'notes/CLAUDE.md' }],
      projectRoot,
    );
    expect(dropped).toEqual([]);
  });

  // Pre-build lanes run BEFORE the artifact exists. A glob over an unbuilt `dist/`
  // must be silent here — `copyGlobEntry` still throws at copy time, where the
  // build genuinely has run and zero matches is a real failure.
  it('is silent for a glob whose base does not exist yet', async () => {
    const projectRoot = makeExtrasSandbox();
    const dropped = await collectDroppedGlobMatches(
      [{ source: 'dist/not-built/**/*', dest: 'packs' }],
      projectRoot,
    );
    expect(dropped).toEqual([]);
  });
});

describe('globEntryDest', () => {
  const PROJECT_ROOT = safePath.resolve('/project');
  const globEntry: SkillFileEntry = { source: GLOB_PACKS_SOURCE, dest: GLOB_PACKS_DEST };
  const abs = (rel: string) => safePath.resolve(PROJECT_ROOT, rel);

  it('rebases a matched source under the declared dest', () => {
    expect(globEntryDest(globEntry, PROJECT_ROOT, abs('dist/packs/alpha/data.json')))
      .toBe('packs/alpha/data.json');
  });

  it('returns undefined for a non-glob entry (its dest is applied by name)', () => {
    expect(globEntryDest({ source: CLI_SOURCE, dest: CLI_DEST }, PROJECT_ROOT, abs(CLI_SOURCE)))
      .toBeUndefined();
  });

  it('returns undefined for a path outside the glob static base', () => {
    expect(globEntryDest(globEntry, PROJECT_ROOT, abs('dist/other/data.json'))).toBeUndefined();
    // The `+ '/'` guard: a sibling directory sharing the base's name prefix.
    expect(globEntryDest(globEntry, PROJECT_ROOT, abs('dist/packsX/data.json'))).toBeUndefined();
  });

  it('returns undefined when the magic remainder does not match', () => {
    // Under the static base, but the glob only takes .json — answering with a dest
    // here would re-point the path map at a file the copy never writes.
    const jsonOnly: SkillFileEntry = { source: 'dist/packs/**/*.json', dest: GLOB_PACKS_DEST };
    expect(globEntryDest(jsonOnly, PROJECT_ROOT, abs('dist/packs/alpha/NOTES.txt'))).toBeUndefined();
    expect(globEntryDest(jsonOnly, PROJECT_ROOT, abs('dist/packs/alpha/data.json')))
      .toBe('packs/alpha/data.json');
  });

  it('returns undefined for a never-packaged basename the glob happened to catch', () => {
    // partitionNeverPackaged DROPS these from the copy, so they have no dest at
    // all — a glob is a net, not a declaration.
    for (const name of ['CLAUDE.md', 'AGENTS.md', 'README.md']) {
      expect(globEntryDest(globEntry, PROJECT_ROOT, abs(`dist/packs/alpha/${name}`)))
        .toBeUndefined();
    }
  });

  it('includes dot files, matching the copy expansion', () => {
    // copyGlobEntry expands with `dot: true`; a predicate that disagreed would
    // leave hidden files packaged twice.
    expect(globEntryDest(globEntry, PROJECT_ROOT, abs('dist/packs/.hidden.json')))
      .toBe('packs/.hidden.json');
  });
});

describe('applyFilesConfig', () => {
  afterEach(() => {
    for (const dir of APPLY_TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('copies a declared source into the skill output dir at its dest', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: DATA_SOURCE, dest: DATA_DEST }];

    const { dests: copied } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

    expect(copied).toEqual([DATA_DEST]);
    const destPath = safePath.join(skillOutputDir, 'data', DATA_FILE);
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, 'utf-8')).toBe(DATA_BYTES);
  });

  it('skips the COPY for entries whose source is already bundled, but still reports the dest', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: DATA_SOURCE, dest: DATA_DEST }];
    const bundledFiles = [safePath.resolve(safePath.join(projectRoot, DATA_SOURCE))];

    const { dests } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir, bundledFiles });

    // No second copy — link traversal already placed the file at entry.dest.
    expect(existsSync(safePath.join(skillOutputDir, 'data', DATA_FILE))).toBe(false);
    // The dest is still declared, so it is still reported: whether traversal or
    // this copy materialized it is an ordering accident, and the post-build orphan
    // check must not get a different answer about whether `files:` declared it.
    expect(dests).toEqual([DATA_DEST]);
  });

  it('still runs the integrity byte check on a bundled-skip entry (dest matches source → pass)', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: DATA_SOURCE, dest: DATA_DEST, integrity: true }];
    const bundledFiles = [safePath.resolve(safePath.join(projectRoot, DATA_SOURCE))];
    // Simulate what link traversal (copyAndRewriteFiles) already did: place the
    // bundled file at entry.dest, byte-identical to the source.
    const destPath = safePath.join(skillOutputDir, 'data', DATA_FILE);
    mkdirSyncReal(safePath.join(skillOutputDir, 'data'), { recursive: true });
    writeFileSync(destPath, DATA_BYTES);

    const { dests } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir, bundledFiles });

    // The copy is still skipped (bundled), but the requested integrity check ran.
    expect(dests).toEqual([DATA_DEST]);
    expect(existsSync(destPath)).toBe(true);
  });

  it('fails the integrity byte check on a bundled-skip entry when dest differs from source', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: DATA_SOURCE, dest: DATA_DEST, integrity: true }];
    const bundledFiles = [safePath.resolve(safePath.join(projectRoot, DATA_SOURCE))];
    // A link-bundled dest whose bytes DON'T match the source must not slip past a
    // requested integrity check just because the copy was skipped.
    mkdirSyncReal(safePath.join(skillOutputDir, 'data'), { recursive: true });
    writeFileSync(safePath.join(skillOutputDir, 'data', DATA_FILE), '{"ok":false}');

    await expect(
      applyFilesConfig({ filesConfig, projectRoot, skillOutputDir, bundledFiles }),
    ).rejects.toThrow(/content mismatch/);
  });

  it('throws when a declared source does not exist', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: 'dist/gen/missing.json', dest: 'x.json' }];

    await expect(applyFilesConfig({ filesConfig, projectRoot, skillOutputDir })).rejects.toThrow(
      /does not exist/,
    );
  });

  it('throws a helpful error when non-glob source is a directory', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    // 'dist/gen' is a directory created by makeApplySandbox
    const filesConfig: SkillFileEntry[] = [{ source: 'dist/gen', dest: 'output' }];

    await expect(applyFilesConfig({ filesConfig, projectRoot, skillOutputDir })).rejects.toThrow(
      /use a glob/,
    );
  });

  it('throws with build-artifact hint when missing source looks like a build product', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: CLI_SOURCE, dest: CLI_DEST }];

    await expect(applyFilesConfig({ filesConfig, projectRoot, skillOutputDir })).rejects.toThrow(
      new RegExp(BUILD_ARTIFACT_FRAGMENT),
    );
  });

  it('throws WITHOUT build-artifact hint when missing source is a plain reference file', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: 'references/data.json', dest: 'data.json' }];

    await expect(applyFilesConfig({ filesConfig, projectRoot, skillOutputDir })).rejects.toThrow(
      /does not exist/,
    );
    await expect(applyFilesConfig({ filesConfig, projectRoot, skillOutputDir })).rejects.not.toThrow(
      new RegExp(BUILD_ARTIFACT_FRAGMENT),
    );
  });

  it('copies nested glob tree rebased under dest', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    // Create source tree: dist/packs/a/x.json, dist/packs/b/y.json
    mkdirSyncReal(safePath.join(projectRoot, 'dist', 'packs', 'a'), { recursive: true });
    mkdirSyncReal(safePath.join(projectRoot, 'dist', 'packs', 'b'), { recursive: true });
    writeFileSync(safePath.join(projectRoot, 'dist', 'packs', 'a', 'x.json'), '{"a":1}');
    writeFileSync(safePath.join(projectRoot, 'dist', 'packs', 'b', 'y.json'), '{"b":2}');

    const filesConfig: SkillFileEntry[] = [{ source: GLOB_PACKS_SOURCE, dest: GLOB_PACKS_DEST }];
    const { dests: copied } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

    // Derive expected dests using safePath + toForwardSlash (never hardcode separators)
    const expectedA = toForwardSlash(safePath.join('packs', 'a', 'x.json'));
    const expectedB = toForwardSlash(safePath.join('packs', 'b', 'y.json'));
    const sortFn = (a: string, b: string) => a.localeCompare(b);
    expect([...copied].sort(sortFn)).toEqual([expectedA, expectedB].sort(sortFn));

    // Files must land with identical content
    expect(readFileSync(safePath.join(skillOutputDir, 'packs', 'a', 'x.json'), 'utf-8')).toBe('{"a":1}');
    expect(readFileSync(safePath.join(skillOutputDir, 'packs', 'b', 'y.json'), 'utf-8')).toBe('{"b":2}');
  });

  it('copies only *.mjs files via flat glob, excludes non-matching extension', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    // Create source: dist/bin/a.mjs, dist/bin/b.mjs, dist/bin/skip.txt
    mkdirSyncReal(safePath.join(projectRoot, 'dist', 'bin'), { recursive: true });
    writeFileSync(safePath.join(projectRoot, 'dist', 'bin', 'a.mjs'), 'a');
    writeFileSync(safePath.join(projectRoot, 'dist', 'bin', 'b.mjs'), 'b');
    writeFileSync(safePath.join(projectRoot, 'dist', 'bin', 'skip.txt'), 'skip');

    const filesConfig: SkillFileEntry[] = [{ source: 'dist/bin/*.mjs', dest: 'scripts' }];
    const { dests: copied } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

    const expectedA = toForwardSlash(safePath.join('scripts', 'a.mjs'));
    const expectedB = toForwardSlash(safePath.join('scripts', 'b.mjs'));
    const sortFn = (a: string, b: string) => a.localeCompare(b);
    expect([...copied].sort(sortFn)).toEqual([expectedA, expectedB].sort(sortFn));

    expect(existsSync(safePath.join(skillOutputDir, 'scripts', 'a.mjs'))).toBe(true);
    expect(existsSync(safePath.join(skillOutputDir, 'scripts', 'b.mjs'))).toBe(true);
    expect(existsSync(safePath.join(skillOutputDir, 'scripts', 'skip.txt'))).toBe(false);
  });

  it('throws when glob matches no files', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: 'dist/nonexistent/**/*', dest: 'out' }];

    await expect(applyFilesConfig({ filesConfig, projectRoot, skillOutputDir })).rejects.toThrow(
      /matched no files/,
    );
  });

  it('integrity pass: glob entry with integrity:true resolves and all files present', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    mkdirSyncReal(safePath.join(projectRoot, 'dist', 'assets'), { recursive: true });
    writeFileSync(safePath.join(projectRoot, 'dist', 'assets', 'a.json'), '{"x":1}');
    writeFileSync(safePath.join(projectRoot, 'dist', 'assets', 'b.json'), '{"y":2}');

    const filesConfig: SkillFileEntry[] = [{ source: 'dist/assets/**/*', dest: 'assets', integrity: true }];
    await expect(applyFilesConfig({ filesConfig, projectRoot, skillOutputDir })).resolves.toBeDefined();

    expect(existsSync(safePath.join(skillOutputDir, 'assets', 'a.json'))).toBe(true);
    expect(existsSync(safePath.join(skillOutputDir, 'assets', 'b.json'))).toBe(true);
  });

  it('rebuild-into-clean-dir: after wiping dest dir, only expected files exist', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    mkdirSyncReal(safePath.join(projectRoot, 'dist', 'pkg'), { recursive: true });
    writeFileSync(safePath.join(projectRoot, 'dist', 'pkg', 'main.js'), 'main');

    const filesConfig: SkillFileEntry[] = [{ source: 'dist/pkg/**/*', dest: 'pkg' }];

    // First build — creates pkg/main.js plus a stale file simulating leftover artifact
    await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });
    const staleFile = safePath.join(skillOutputDir, 'pkg', 'stale.js');
    writeFileSync(staleFile, 'stale');

    // Wipe the dest dir (mirrors skill-packager behavior at build start)
    rmSync(safePath.join(skillOutputDir, 'pkg'), { recursive: true, force: true });

    // Second build into clean dir
    await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

    // Only expected file; stale is gone because we wiped before re-running
    const pkgDir = safePath.join(skillOutputDir, 'pkg');
    expect(existsSync(safePath.join(pkgDir, 'main.js'))).toBe(true);
    expect(existsSync(staleFile)).toBe(false);
  });

  // H1 — a dest that would escape the skill output dir must be rejected by
  // joinUnderRoot (defense-in-depth beyond the schema refine).
  it('throws when a non-glob dest escapes the skill output dir (joinUnderRoot guard)', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: DATA_SOURCE, dest: '../escape.json' }];

    await expect(applyFilesConfig({ filesConfig, projectRoot, skillOutputDir })).rejects.toThrow(
      /escapes root|joinUnderRoot/,
    );
  });

  // H2 — a glob whose MAGIC REMAINDER (the part after the static base) contains
  // a '..' segment must be rejected; it would let `glob` climb above the base.
  it('throws when a glob magic remainder contains a ".." segment', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: 'dist/gen/*/../../../etc/*', dest: 'out' }];

    await expect(applyFilesConfig({ filesConfig, projectRoot, skillOutputDir })).rejects.toThrow(
      /\.\.|traversal|glob portion/,
    );
  });

  // H2 — the deliberate sibling-base feature (static base with leading '..') must
  // keep working: only the MAGIC REMAINDER is constrained, not the static base.
  it('still expands a sibling-base glob (../pkg/dist/**) whose remainder has no ".."', async () => {
    const { projectRoot } = makeApplySandbox();
    // projectRoot is <root>/project; create a sibling <root>/sibling/lib/x.js
    const siblingLib = safePath.join(projectRoot, '..', 'sibling', 'lib');
    mkdirSyncReal(siblingLib, { recursive: true });
    writeFileSync(safePath.join(siblingLib, 'x.js'), 'export const x = 1;');
    const skillOutputDir = safePath.join(projectRoot, '..', 'sibling-out');
    mkdirSyncReal(skillOutputDir, { recursive: true });
    APPLY_TMP_DIRS.push(skillOutputDir);

    const filesConfig: SkillFileEntry[] = [{ source: '../sibling/lib/**/*.js', dest: 'lib' }];
    const { dests: copied } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

    expect(copied).toEqual([toForwardSlash(safePath.join('lib', 'x.js'))]);
    expect(existsSync(safePath.join(skillOutputDir, 'lib', 'x.js'))).toBe(true);
  });

  // M10 — dot-files under a glob source must be included (copy + integrity stay
  // symmetric: both globs pass dot: true).
  it('includes dot-files when expanding a glob source', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const hiddenFile = '.hidden.json';
    mkdirSyncReal(safePath.join(projectRoot, 'dist', 'packs'), { recursive: true });
    writeFileSync(safePath.join(projectRoot, 'dist', 'packs', 'visible.json'), '{"v":1}');
    writeFileSync(safePath.join(projectRoot, 'dist', 'packs', hiddenFile), '{"h":1}');

    const filesConfig: SkillFileEntry[] = [{ source: 'dist/packs/**/*', dest: 'packs', integrity: true }];
    const { dests: copied } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

    expect(copied).toContain(toForwardSlash(safePath.join('packs', hiddenFile)));
    expect(existsSync(safePath.join(skillOutputDir, 'packs', hiddenFile))).toBe(true);
    expect(existsSync(safePath.join(skillOutputDir, 'packs', 'visible.json'))).toBe(true);
  });

  // A glob entry whose matched source is ALSO linked from SKILL.md by its source
  // path gets that source in `bundledFiles`. Unlike a non-glob entry — whose
  // bundled copy the packager re-routes TO `entry.dest` via the path map — glob
  // entries are deliberately absent from that path map, so link traversal drops
  // the file at its own resource-named location. Skipping the copy therefore
  // leaves the DECLARED dest subtree short a declared file, silently.
  it('glob entry: a link-bundled matched source still lands at its declared dest and is reported', async () => {
    const s = makePackGlobSandbox();
    const filesConfig: SkillFileEntry[] = [{ source: PACK_GLOB_SOURCE, dest: PACK_GLOB_DEST }];

    const { dests: copied } = await applyFilesConfig({
      filesConfig,
      projectRoot: s.projectRoot,
      skillOutputDir: s.skillOutputDir,
      bundledFiles: [s.bundledGuideSource],
    });

    // Reported: the dest is declared either way (applyFilesConfig's documented contract).
    const sortFn = (a: string, b: string) => a.localeCompare(b);
    expect([...copied].sort(sortFn)).toEqual([s.dataDest, s.guideDest].sort(sortFn));

    // Materialized: the declared dest subtree is COMPLETE, not short the bundled file.
    const guidePath = safePath.join(s.skillOutputDir, PACK_GLOB_DEST, 'alpha', 'GUIDE.md');
    expect(existsSync(guidePath)).toBe(true);
    expect(readFileSync(guidePath, 'utf-8')).toBe(PACK_GUIDE_BYTES);
  });

  // The same defect defeats an opted-in integrity check: the skipped file is in
  // NEITHER the expected rel set NOR the on-disk dest subtree, so verifyDestSet's
  // two sets stay consistent and it passes while the subtree is short a file.
  // An integrity check that is silently defeated is worse than one that fires.
  it('glob entry with integrity:true is not silently satisfied by a link-bundled matched source', async () => {
    const s = makePackGlobSandbox();
    const filesConfig: SkillFileEntry[] = [
      { source: PACK_GLOB_SOURCE, dest: PACK_GLOB_DEST, integrity: true },
    ];

    await expect(
      applyFilesConfig({
        filesConfig,
        projectRoot: s.projectRoot,
        skillOutputDir: s.skillOutputDir,
        bundledFiles: [s.bundledGuideSource],
      }),
    ).resolves.toBeDefined();

    expect(
      existsSync(safePath.join(s.skillOutputDir, PACK_GLOB_DEST, 'alpha', 'GUIDE.md')),
    ).toBe(true);
  });

  // Negative polarity: reporting a link-bundled dest must NOT make the glob path
  // permissive. A file under the dest subtree that the glob never matched is still
  // an unexpected file, and a packaged file no entry accounts for is still absent
  // from the returned dests (so the post-build orphan check still catches it).
  it('glob entry: bundled-source handling stays strict about files it does not account for', async () => {
    const s = makePackGlobSandbox();
    const orphan = safePath.join(s.skillOutputDir, PACK_GLOB_DEST, 'alpha', 'orphan.json');
    mkdirSyncReal(safePath.join(s.skillOutputDir, PACK_GLOB_DEST, 'alpha'), { recursive: true });
    writeFileSync(orphan, '{"orphan":true}');

    const opts = {
      filesConfig: [{ source: PACK_GLOB_SOURCE, dest: PACK_GLOB_DEST }] as SkillFileEntry[],
      projectRoot: s.projectRoot,
      skillOutputDir: s.skillOutputDir,
      bundledFiles: [s.bundledGuideSource],
    };

    // Without integrity: the undeclared file is never reported as accounted for.
    const { dests: copied } = await applyFilesConfig(opts);
    expect(copied).not.toContain(toForwardSlash(safePath.join(PACK_GLOB_DEST, 'alpha', 'orphan.json')));

    // With integrity: the dest-subtree set check still fires on it.
    await expect(
      applyFilesConfig({
        ...opts,
        filesConfig: [{ source: PACK_GLOB_SOURCE, dest: PACK_GLOB_DEST, integrity: true }],
      }),
    ).rejects.toThrow(/unexpected file '[^']*orphan\.json'/);
  });
});

// ---------------------------------------------------------------------------
// Never-package defaults: a GLOB honors the list, an EXPLICIT entry does not.
// ---------------------------------------------------------------------------

const EXTRAS_DIR = 'extras';
const EXTRAS_GLOB = `${EXTRAS_DIR}/**/*`;
/** Files a glob must never drag into a skill bundle (tier 1 + tier 2). */
const NEVER_PACKAGED = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', 'README.md', 'index.md'];
/** Files that must survive the same glob. */
const STILL_PACKAGED = ['data.json', 'notes.md'];
/** A never-packaged basename OUTSIDE the glob's reach — the escape-hatch subject. */
const DOCS_README = 'docs/README.md';

/**
 * `<projectRoot>/extras/` holding both never-packaged and ordinary files, plus
 * (optionally) an untouched `docs/README.md` in a directory the glob does NOT
 * cover — the escape-hatch case needs a file the glob cannot also have shipped,
 * or the assertion passes vacuously ([[fixtures-that-cannot-distinguish]]).
 */
function makeNeverPackageSandbox(
  contents: readonly string[] = [...NEVER_PACKAGED, ...STILL_PACKAGED],
): { projectRoot: string; skillOutputDir: string } {
  const { projectRoot, skillOutputDir } = makeApplySandbox();
  const extras = safePath.join(projectRoot, EXTRAS_DIR);
  mkdirSyncReal(extras, { recursive: true });
  for (const name of contents) {
    writeFileSync(safePath.join(extras, name), `content of ${name}\n`);
  }
  const docs = safePath.join(projectRoot, 'docs');
  mkdirSyncReal(docs, { recursive: true });
  writeFileSync(safePath.join(docs, 'README.md'), 'deliberate front page\n');
  return { projectRoot, skillOutputDir };
}

/** Sorted comparison of skill-output-relative paths (order is not part of the contract). */
function expectSamePaths(actual: readonly string[], expected: readonly string[]): void {
  const byName = (a: string, b: string): number => a.localeCompare(b);
  expect([...actual].sort(byName)).toEqual([...expected].sort(byName));
}

/** The `extras/<name>` dests a glob entry would produce for these basenames. */
function extrasDests(names: readonly string[]): string[] {
  return names.map((n) => `${EXTRAS_DIR}/${n}`);
}

describe('applyFilesConfig never-package defaults', () => {
  afterEach(() => {
    for (const dir of APPLY_TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('drops agent-instruction and navigation files a glob matched, and keeps the rest', async () => {
    const { projectRoot, skillOutputDir } = makeNeverPackageSandbox();
    const filesConfig: SkillFileEntry[] = [{ source: EXTRAS_GLOB, dest: EXTRAS_DIR }];

    const { dests: copied } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

    expectSamePaths(copied, extrasDests(STILL_PACKAGED));
    for (const name of NEVER_PACKAGED) {
      expect(existsSync(safePath.join(skillOutputDir, EXTRAS_DIR, name))).toBe(false);
    }
    for (const name of STILL_PACKAGED) {
      expect(existsSync(safePath.join(skillOutputDir, EXTRAS_DIR, name))).toBe(true);
    }
  });

  it('still ships a never-packaged file named by an EXPLICIT entry (the escape hatch)', async () => {
    const { projectRoot, skillOutputDir } = makeNeverPackageSandbox();
    // The explicit entry names docs/README.md, which the glob does not cover — so
    // its presence in the output can only be the explicit entry's doing.
    const filesConfig: SkillFileEntry[] = [
      { source: EXTRAS_GLOB, dest: EXTRAS_DIR },
      { source: DOCS_README, dest: DOCS_README },
    ];

    const { dests: copied } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

    expect(copied).toContain(DOCS_README);
    expect(existsSync(safePath.join(skillOutputDir, 'docs', 'README.md'))).toBe(true);
    // ...while the glob's own README is still dropped.
    expect(existsSync(safePath.join(skillOutputDir, EXTRAS_DIR, 'README.md'))).toBe(false);
  });

  it('keeps integrity honest: the dest-set check sees exactly the surviving files', async () => {
    const { projectRoot, skillOutputDir } = makeNeverPackageSandbox();
    const filesConfig: SkillFileEntry[] = [
      { source: EXTRAS_GLOB, dest: EXTRAS_DIR, integrity: true },
    ];

    // A dropped file must land in neither `rels` nor the on-disk subtree, or
    // verifyDestSet reports it as missing/unexpected. Asserted as an EXACT list:
    // `arrayContaining` is a superset check that survives deleting the whole
    // never-package filter, so it could never have failed on a regression.
    const { dests } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });
    expectSamePaths(dests, extrasDests(STILL_PACKAGED));
  });

  // The basename lane must use the shared case-insensitive matcher, not a raw
  // Set: on APFS/NTFS a `Claude.md` satisfies Claude Code's project-local
  // instruction lookup exactly as `CLAUDE.md` does, so a case-sensitive check
  // leaves the whole harm reachable by renaming one letter.
  it('drops never-packaged basenames whatever their case', async () => {
    const oddSpellings = ['Claude.md', 'Readme.md', 'INDEX.MD'];
    const { projectRoot, skillOutputDir } = makeNeverPackageSandbox([
      ...oddSpellings,
      ...STILL_PACKAGED,
    ]);
    const filesConfig: SkillFileEntry[] = [{ source: EXTRAS_GLOB, dest: EXTRAS_DIR }];

    const { dests, dropped } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

    expectSamePaths(dropped.map((d) => d.dest), extrasDests(oddSpellings));
    expectSamePaths(dests, extrasDests(STILL_PACKAGED));
  });

  it('reports each file the never-package list dropped, with the dest it would have had', async () => {
    const { projectRoot, skillOutputDir } = makeNeverPackageSandbox();
    const filesConfig: SkillFileEntry[] = [{ source: EXTRAS_GLOB, dest: EXTRAS_DIR }];

    const { dropped } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

    // Structured, not a stderr line: this is what makes the drop visible in the
    // machine-readable build report (and what feeds the broken-link clause).
    expectSamePaths(dropped.map((d) => d.dest), extrasDests(NEVER_PACKAGED));
    expect(new Set(dropped.map((d) => d.source))).toEqual(new Set([EXTRAS_GLOB]));
  });

  // The escape hatch the drop's own error message (and the guide) prescribes:
  // name the never-packaged file in an EXPLICIT entry so it ships anyway. With
  // `integrity: true` on the glob covering the same subtree, that config used to
  // pass or throw depending purely on the order the two entries appear in —
  // explicit-first threw `unexpected file 'README.md'`, glob-first passed. Same
  // config, opposite verdicts, and the error blamed integrity with no hint that
  // ordering or the never-package list was involved.
  //
  // Both orders are asserted because either one alone is satisfiable by a fix
  // that just re-sorts the entries instead of making the check order-independent.
  describe.each([
    { label: 'explicit entry first', explicitFirst: true },
    { label: 'glob entry first', explicitFirst: false },
  ])('integrity glob + explicit escape hatch ($label)', ({ explicitFirst }) => {
    const explicit: SkillFileEntry = {
      source: `${EXTRAS_DIR}/README.md`,
      dest: `${EXTRAS_DIR}/README.md`,
    };
    const globEntry: SkillFileEntry = {
      source: EXTRAS_GLOB,
      dest: EXTRAS_DIR,
      integrity: true,
    };

    it('ships the explicitly-named file into the integrity-checked dest subtree', async () => {
      const { projectRoot, skillOutputDir } = makeNeverPackageSandbox();
      const filesConfig = explicitFirst ? [explicit, globEntry] : [globEntry, explicit];

      const { dests } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

      expectSamePaths(dests, extrasDests([...STILL_PACKAGED, 'README.md']));
      expect(existsSync(safePath.join(skillOutputDir, EXTRAS_DIR, 'README.md'))).toBe(true);
      // The OTHER never-packaged files stay dropped — the escape hatch is per-file.
      expect(existsSync(safePath.join(skillOutputDir, EXTRAS_DIR, 'CLAUDE.md'))).toBe(false);
    });

    // FILES_GLOB_DROPPED_NEVER_PACKAGED says the file "was dropped and did not
    // ship". In the escape-hatch config that sentence is FALSE for README.md —
    // the glob dropped it, the explicit entry shipped it, and the finding would
    // tell an author their documented remediation had failed. A drop is only
    // reportable when nothing else put the file in the bundle.
    it('does not report a drop for a file another entry ships', async () => {
      const { projectRoot, skillOutputDir } = makeNeverPackageSandbox();
      const filesConfig = explicitFirst ? [explicit, globEntry] : [globEntry, explicit];

      const { dropped } = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

      expect(dropped.map((d) => d.dest)).not.toContain(`${EXTRAS_DIR}/README.md`);
      // …but the genuinely-dropped siblings are still reported.
      expect(dropped.map((d) => d.dest)).toContain(`${EXTRAS_DIR}/CLAUDE.md`);
    });

    // The set check must still be a statement about the SHIPPED bundle: an
    // unexpected file no entry accounts for has to fail in both orders too,
    // otherwise "order-independent" was bought by making the check permissive.
    it('still rejects a file under the dest subtree that no entry declares', async () => {
      const { projectRoot, skillOutputDir } = makeNeverPackageSandbox();
      mkdirSyncReal(safePath.join(skillOutputDir, EXTRAS_DIR), { recursive: true });
      writeFileSync(safePath.join(skillOutputDir, EXTRAS_DIR, 'stray.json'), '{"stray":true}');
      const filesConfig = explicitFirst ? [explicit, globEntry] : [globEntry, explicit];

      await expect(
        applyFilesConfig({ filesConfig, projectRoot, skillOutputDir }),
      ).rejects.toThrow(/unexpected file 'stray\.json'/);
    });
  });

  it('reports the exclusion — not "has your build run?" — when only never-packaged files match', async () => {
    const { projectRoot, skillOutputDir } = makeNeverPackageSandbox(NEVER_PACKAGED);
    const filesConfig: SkillFileEntry[] = [{ source: EXTRAS_GLOB, dest: EXTRAS_DIR }];

    const attempt = applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });
    await expect(attempt).rejects.toThrow(/never packaged/);
    await expect(attempt).rejects.not.toThrow(/has your build run/);
  });
});

const INTEGRITY_TMP_PREFIX = 'vat-integrity-';

/** Create an isolated temp dir and return src + dst paths under it (dst defaults to dst.txt). */
function makeIntegrityPair(dstName = 'dst.txt'): { srcFile: string; dstFile: string } {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), INTEGRITY_TMP_PREFIX));
  APPLY_TMP_DIRS.push(root);
  return { srcFile: safePath.join(root, 'src.txt'), dstFile: safePath.join(root, dstName) };
}

describe('verifyFilesIntegrity', () => {
  afterEach(() => {
    for (const dir of APPLY_TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('passes when all dest files match their sources byte-for-byte', () => {
    const { srcFile, dstFile } = makeIntegrityPair();
    writeFileSync(srcFile, 'hello');
    writeFileSync(dstFile, 'hello');

    expect(() => verifyFilesIntegrity([{ absSource: srcFile, absDest: dstFile }])).not.toThrow();
  });

  it('throws when dest content differs from source', () => {
    const { srcFile, dstFile } = makeIntegrityPair();
    writeFileSync(srcFile, 'original');
    writeFileSync(dstFile, 'tampered');

    expect(() => verifyFilesIntegrity([{ absSource: srcFile, absDest: dstFile }])).toThrow(
      toForwardSlash(dstFile),
    );
  });

  it('throws when dest file is missing', () => {
    const { srcFile, dstFile } = makeIntegrityPair('missing.txt');
    writeFileSync(srcFile, 'data');

    expect(() => verifyFilesIntegrity([{ absSource: srcFile, absDest: dstFile }])).toThrow(
      toForwardSlash(dstFile),
    );
  });
});

const GLOB_SOURCE = 'dist/assets/**/*';

/** Create an isolated dest subtree (tracked for cleanup) and return its absolute path. */
function makeDestDir(): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), INTEGRITY_TMP_PREFIX));
  APPLY_TMP_DIRS.push(root);
  const destDir = safePath.join(root, 'assets');
  mkdirSyncReal(destDir, { recursive: true });
  return destDir;
}

describe('verifyDestSet', () => {
  afterEach(() => {
    for (const dir of APPLY_TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('passes when the dest subtree exactly equals the expected rel set', async () => {
    const destDir = makeDestDir();
    writeFileSync(safePath.join(destDir, 'a.json'), '{"x":1}');
    writeFileSync(safePath.join(destDir, 'b.json'), '{"y":2}');

    await expect(
      verifyDestSet(destDir, ['a.json', 'b.json'], GLOB_SOURCE),
    ).resolves.toBeUndefined();
  });

  it('throws naming an unexpected file when the subtree has an extra path', async () => {
    const destDir = makeDestDir();
    writeFileSync(safePath.join(destDir, 'a.json'), '{"x":1}');
    writeFileSync(safePath.join(destDir, 'rogue.json'), '{"z":3}');

    await expect(
      verifyDestSet(destDir, ['a.json'], GLOB_SOURCE),
    ).rejects.toThrow(/unexpected file 'rogue\.json'/);
  });

  it('throws naming a missing file when an expected path is absent', async () => {
    const destDir = makeDestDir();
    writeFileSync(safePath.join(destDir, 'a.json'), '{"x":1}');

    await expect(
      verifyDestSet(destDir, ['a.json', 'b.json'], GLOB_SOURCE),
    ).rejects.toThrow(/missing expected file 'b\.json'/);
  });
});

// ============================================================================
// buildArtifactHint
// ============================================================================

describe('buildArtifactHint', () => {
  // Positives: should return a non-empty hint clause

  it('returns hint for dist/ segment (bin/cli.mjs)', () => {
    expect(buildArtifactHint(CLI_SOURCE)).toContain(BUILD_ARTIFACT_FRAGMENT);
  });

  it('returns hint for build/ segment', () => {
    expect(buildArtifactHint('build/out.js')).toContain(BUILD_ARTIFACT_FRAGMENT);
  });

  it('returns hint for out/ segment', () => {
    expect(buildArtifactHint('a/out/b.mjs')).toContain(BUILD_ARTIFACT_FRAGMENT);
  });

  it('returns hint for nested dist/ segment in a longer path', () => {
    expect(buildArtifactHint('packages/x/dist/y.cjs')).toContain(BUILD_ARTIFACT_FRAGMENT);
  });

  it('returns hint for .mjs extension alone (no dist segment)', () => {
    expect(buildArtifactHint('scripts/bundle.mjs')).toContain(BUILD_ARTIFACT_FRAGMENT);
  });

  it('returns hint for .cjs extension alone', () => {
    expect(buildArtifactHint('lib/helper.cjs')).toContain(BUILD_ARTIFACT_FRAGMENT);
  });

  it('returns hint for .js extension alone', () => {
    expect(buildArtifactHint('generated/output.js')).toContain(BUILD_ARTIFACT_FRAGMENT);
  });

  it('returns hint for .bundle.* extension', () => {
    expect(buildArtifactHint('assets/app.bundle.min')).toContain(BUILD_ARTIFACT_FRAGMENT);
  });

  // Negatives: should return empty string

  it('returns empty string for references/data.json (no artifact segment or extension)', () => {
    expect(buildArtifactHint('references/data.json')).toBe('');
  });

  it('returns empty string for README.md', () => {
    expect(buildArtifactHint('README.md')).toBe('');
  });

  it('returns empty string for assets/logo.png', () => {
    expect(buildArtifactHint('assets/logo.png')).toBe('');
  });

  it('returns empty string for redistribute/data.json (dist is NOT a segment match)', () => {
    // "redistribute" contains "dist" as a substring but must NOT match
    expect(buildArtifactHint('redistribute/data.json')).toBe('');
  });

  it('returns hint for a backslash path (toForwardSlash normalization at the call site)', () => {
    // Windows-style backslash path must be normalized before segment matching.
    expect(buildArtifactHint(String.raw`dist\bin\cli.mjs`)).toContain(BUILD_ARTIFACT_FRAGMENT);
  });
});
