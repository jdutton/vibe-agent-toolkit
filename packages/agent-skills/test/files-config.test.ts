/* eslint-disable security/detect-non-literal-fs-filename -- test sandbox paths derived from tmp dirs */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyFilesConfig,
  mergeFilesConfig,
  matchLinkToFiles,
  computeDeferredPaths,
  type SkillFileEntry,
} from '../src/files-config.js';

const CLI_SOURCE = 'dist/bin/cli.mjs';
const CLI_DEST = 'scripts/cli.mjs';

/** Tmp dirs created by applyFilesConfig tests, cleaned up after each. */
const APPLY_TMP_DIRS: string[] = [];
/** Shared filenames/dests used across applyFilesConfig cases. */
const DATA_FILE = 'data.json';
const DATA_DEST = `data/${DATA_FILE}`;
const DATA_SOURCE = `dist/gen/${DATA_FILE}`;

/** Create an isolated {projectRoot, skillOutputDir} sandbox with a build artifact source. */
function makeApplySandbox(): { projectRoot: string; skillOutputDir: string } {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-apply-files-'));
  APPLY_TMP_DIRS.push(root);
  const projectRoot = safePath.join(root, 'project');
  const skillOutputDir = safePath.join(root, 'out');
  mkdirSyncReal(safePath.join(projectRoot, 'dist', 'gen'), { recursive: true });
  mkdirSyncReal(skillOutputDir, { recursive: true });
  writeFileSync(safePath.join(projectRoot, 'dist', 'gen', DATA_FILE), '{"ok":true}');
  return { projectRoot, skillOutputDir };
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

describe('matchLinkToFiles', () => {
  const files: SkillFileEntry[] = [
    { source: CLI_SOURCE, dest: CLI_DEST },
    { source: 'src/templates/config.json', dest: 'scripts/config.json' },
  ];

  it('should match when link target matches files[].source', () => {
    const result = matchLinkToFiles(CLI_SOURCE, files);
    expect(result).toEqual({ match: 'source', entry: files[0] });
  });

  it('should match when link target matches files[].dest', () => {
    const result = matchLinkToFiles(CLI_DEST, files);
    expect(result).toEqual({ match: 'dest', entry: files[0] });
  });

  it('should return null when no match', () => {
    const result = matchLinkToFiles('other/file.mjs', files);
    expect(result).toBeNull();
  });

  it('should normalize paths with ./ prefix', () => {
    const result = matchLinkToFiles(`./${CLI_SOURCE}`, files);
    expect(result).toEqual({ match: 'source', entry: files[0] });
  });

  it('should prefer source match over dest match when both match', () => {
    const ambiguousFiles: SkillFileEntry[] = [
      { source: CLI_DEST, dest: 'tools/cli.mjs' },
      { source: 'other/tool.mjs', dest: CLI_DEST },
    ];
    const result = matchLinkToFiles(CLI_DEST, ambiguousFiles);
    expect(result?.match).toBe('source');
    expect(result?.entry).toBe(ambiguousFiles[0]);
  });
});

describe('computeDeferredPaths', () => {
  it('should return empty sets when no files config', () => {
    const result = computeDeferredPaths([], { skillDir: '/proj', projectRoot: '/proj' });
    expect(result.destPaths).toEqual(new Set());
    expect(result.sourcePaths).toEqual(new Set());
  });

  it('should put dest in destPaths and source in sourcePaths (skill at project root)', () => {
    // When skillDir === projectRoot, dest and source paths are project-root-relative as authored
    const files: SkillFileEntry[] = [
      { source: CLI_SOURCE, dest: CLI_DEST },
    ];
    const result = computeDeferredPaths(files, { skillDir: '/proj', projectRoot: '/proj' });
    expect(result.destPaths.has(CLI_DEST)).toBe(true);
    expect(result.sourcePaths.has(CLI_SOURCE)).toBe(true);
    // Each path should be in its own set, not cross-contaminated
    expect(result.destPaths.has(CLI_SOURCE)).toBe(false);
    expect(result.sourcePaths.has(CLI_DEST)).toBe(false);
  });

  it('should deduplicate within each set across multiple entries', () => {
    const files: SkillFileEntry[] = [
      { source: CLI_SOURCE, dest: CLI_DEST },
      { source: CLI_SOURCE, dest: 'scripts/cli2.mjs' },
    ];
    const result = computeDeferredPaths(files, { skillDir: '/proj', projectRoot: '/proj' });
    // CLI_SOURCE appears once in sourcePaths (deduped)
    expect(result.sourcePaths.size).toBe(1);
    // CLI_DEST and 'scripts/cli2.mjs' are distinct in destPaths
    expect(result.destPaths.size).toBe(2);
  });

  it('should normalize paths with ./ prefix (skill at project root)', () => {
    const files: SkillFileEntry[] = [
      { source: `./${CLI_SOURCE}`, dest: `./${CLI_DEST}` },
    ];
    const result = computeDeferredPaths(files, { skillDir: '/proj', projectRoot: '/proj' });
    expect(result.sourcePaths.has(CLI_SOURCE)).toBe(true);
    expect(result.destPaths.has(CLI_DEST)).toBe(true);
  });

  it('resolves an absolute-looking source the same way the packager does (join, not bare resolve)', () => {
    // Carry-forward #4: skill-packager resolves source via
    // `safePath.resolve(safePath.join(projectRoot, source))`, which roots an
    // absolute-looking source UNDER projectRoot. computeDeferredPaths must use
    // the identical expression so the deferred set matches what the packager
    // copies — a bare `resolve(projectRoot, source)` would treat the leading
    // slash as escaping the project root and produce a '../'-prefixed path that
    // never matches the walker's project-relative `rel`.
    const files: SkillFileEntry[] = [
      { source: '/dist/bin/cli.mjs', dest: CLI_DEST },
    ];
    const result = computeDeferredPaths(files, { skillDir: '/proj', projectRoot: '/proj' });
    expect(result.sourcePaths.has('dist/bin/cli.mjs')).toBe(true);
  });

  it('should resolve dest relative to skillDir and emit project-root-relative path for skill in subdirectory', () => {
    // Bug regression test: skill is at /proj/skills/ado/SKILL.md
    // skillDir = /proj/skills/ado, projectRoot = /proj
    // files: [{ source: 'dist/bin/ado-cli.mjs', dest: 'scripts/ado-cli.mjs' }]
    // dest authored relative to skillDir → absolute: /proj/skills/ado/scripts/ado-cli.mjs
    // expected destPath (project-root-relative): 'skills/ado/scripts/ado-cli.mjs'
    // source authored relative to projectRoot → absolute: /proj/dist/bin/ado-cli.mjs
    // expected sourcePath (project-root-relative): 'dist/bin/ado-cli.mjs'
    const files: SkillFileEntry[] = [
      { source: 'dist/bin/ado-cli.mjs', dest: 'scripts/ado-cli.mjs' },
    ];
    const result = computeDeferredPaths(files, {
      skillDir: '/proj/skills/ado',
      projectRoot: '/proj',
    });

    // destPath must be project-root-relative (including the skill subdir prefix)
    expect(result.destPaths.has('skills/ado/scripts/ado-cli.mjs')).toBe(true);
    // sourcePath must be project-root-relative (as authored, relative to projectRoot)
    expect(result.sourcePaths.has('dist/bin/ado-cli.mjs')).toBe(true);

    // Must NOT contain the raw (skill-dir-relative) dest that the bug would have stored
    expect(result.destPaths.has('scripts/ado-cli.mjs')).toBe(false);
  });
});

describe('applyFilesConfig', () => {
  afterEach(() => {
    for (const dir of APPLY_TMP_DIRS.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('copies a declared source into the skill output dir at its dest', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: DATA_SOURCE, dest: DATA_DEST }];

    const copied = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir });

    expect(copied).toEqual([DATA_DEST]);
    const destPath = safePath.join(skillOutputDir, 'data', DATA_FILE);
    expect(existsSync(destPath)).toBe(true);
    expect(readFileSync(destPath, 'utf-8')).toBe('{"ok":true}');
  });

  it('skips entries whose source is already bundled', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: DATA_SOURCE, dest: DATA_DEST }];
    const bundledFiles = [safePath.resolve(safePath.join(projectRoot, DATA_SOURCE))];

    const copied = await applyFilesConfig({ filesConfig, projectRoot, skillOutputDir, bundledFiles });

    expect(copied).toEqual([]);
    expect(existsSync(safePath.join(skillOutputDir, 'data', DATA_FILE))).toBe(false);
  });

  it('throws when a declared source does not exist', async () => {
    const { projectRoot, skillOutputDir } = makeApplySandbox();
    const filesConfig: SkillFileEntry[] = [{ source: 'dist/gen/missing.json', dest: 'x.json' }];

    await expect(applyFilesConfig({ filesConfig, projectRoot, skillOutputDir })).rejects.toThrow(
      /does not exist/,
    );
  });
});
