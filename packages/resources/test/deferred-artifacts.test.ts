import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { DeferredArtifacts, type DeferredSkillFiles } from '../src/deferred-artifacts.js';
import type { SkillFileEntry } from '../src/schemas/project-config.js';

const PROJ_ROOT = '/proj';
const CLI_SOURCE = 'dist/bin/cli.mjs';
const CLI_DEST = 'scripts/cli.mjs';
const GLOB_PACKS_SOURCE = 'dist/packs/**/*';
const GLOB_PACKS_DEST = 'packs';

/** Build a single-skill DeferredArtifacts at PROJ_ROOT (skillDir === projectRoot unless overridden). */
function fromSingleSkill(files: SkillFileEntry[], skillDir = PROJ_ROOT): DeferredArtifacts {
  return DeferredArtifacts.from([{ files, skillDir }], PROJ_ROOT);
}

/** Shared fixture for the "unrelated path" negative-control tests in both .covers and .coversDest suites. */
function unrelatedPathArtifacts(): DeferredArtifacts {
  return fromSingleSkill([{ source: CLI_SOURCE, dest: CLI_DEST }]);
}

describe('DeferredArtifacts.from', () => {
  it('should return empty sets when no files config', () => {
    const result = fromSingleSkill([]);
    expect(result.destPaths).toEqual(new Set());
    expect(result.sourcePaths).toEqual(new Set());
  });

  it('should put dest in destPaths and source in sourcePaths (skill at project root)', () => {
    const files: SkillFileEntry[] = [{ source: CLI_SOURCE, dest: CLI_DEST }];
    const result = fromSingleSkill(files);
    expect(result.destPaths.has(CLI_DEST)).toBe(true);
    expect(result.sourcePaths.has(CLI_SOURCE)).toBe(true);
    expect(result.destPaths.has(CLI_SOURCE)).toBe(false);
    expect(result.sourcePaths.has(CLI_DEST)).toBe(false);
  });

  it('should deduplicate within each set across multiple entries', () => {
    const files: SkillFileEntry[] = [
      { source: CLI_SOURCE, dest: CLI_DEST },
      { source: CLI_SOURCE, dest: 'scripts/cli2.mjs' },
    ];
    const result = fromSingleSkill(files);
    expect(result.sourcePaths.size).toBe(1);
    expect(result.destPaths.size).toBe(2);
  });

  it('should normalize paths with ./ prefix (skill at project root)', () => {
    const files: SkillFileEntry[] = [{ source: `./${CLI_SOURCE}`, dest: `./${CLI_DEST}` }];
    const result = fromSingleSkill(files);
    expect(result.sourcePaths.has(CLI_SOURCE)).toBe(true);
    expect(result.destPaths.has(CLI_DEST)).toBe(true);
  });

  it('resolves an absolute-looking source the same way the packager does (join, not bare resolve)', () => {
    // skill-packager resolves source via safePath.resolve(safePath.join(projectRoot,
    // source)), which roots an absolute-looking source UNDER projectRoot.
    // DeferredArtifacts.from must use the identical expression so the deferred set
    // matches what the packager copies — a bare `resolve(projectRoot, source)` would
    // treat the leading slash as escaping the project root and produce a
    // '../'-prefixed path that never matches the walker's project-relative `rel`.
    const files: SkillFileEntry[] = [{ source: '/dist/bin/cli.mjs', dest: CLI_DEST }];
    const result = fromSingleSkill(files);
    expect(result.sourcePaths.has(CLI_SOURCE)).toBe(true);
  });

  it('should resolve dest relative to skillDir and emit project-root-relative path for skill in subdirectory', () => {
    // skill is at /proj/skills/ado/SKILL.md; skillDir = /proj/skills/ado, projectRoot = /proj
    const files: SkillFileEntry[] = [{ source: 'dist/bin/ado-cli.mjs', dest: 'scripts/ado-cli.mjs' }];
    const result = fromSingleSkill(files, `${PROJ_ROOT}/skills/ado`);

    expect(result.destPaths.has('skills/ado/scripts/ado-cli.mjs')).toBe(true);
    expect(result.sourcePaths.has('dist/bin/ado-cli.mjs')).toBe(true);
    expect(result.destPaths.has('scripts/ado-cli.mjs')).toBe(false);
  });

  // ---- Glob entry: static-base registration ----

  it('glob entry: sourcePaths registers the STATIC BASE, not the raw glob pattern', () => {
    const files: SkillFileEntry[] = [{ source: GLOB_PACKS_SOURCE, dest: GLOB_PACKS_DEST }];
    const result = fromSingleSkill(files);

    const bases = [...result.sourcePaths].sort((a, b) => a.localeCompare(b));
    expect(bases).toContain(toForwardSlash(safePath.join('dist', 'packs')));
    expect(result.sourcePaths.has(GLOB_PACKS_SOURCE)).toBe(false);
  });

  it('glob entry: destPaths registers the dest dir unchanged (same as non-glob)', () => {
    const files: SkillFileEntry[] = [{ source: GLOB_PACKS_SOURCE, dest: GLOB_PACKS_DEST }];
    const result = fromSingleSkill(files);
    expect(result.destPaths.has(GLOB_PACKS_DEST)).toBe(true);
  });

  // ---- Multi-skill construction ----

  it('merges destPaths and sourcePaths across multiple skills sharing one project root', () => {
    const skillA: DeferredSkillFiles = {
      files: [{ source: 'dist/a/cli.mjs', dest: 'scripts/a-cli.mjs' }],
      skillDir: `${PROJ_ROOT}/skills/a`,
    };
    const skillB: DeferredSkillFiles = {
      files: [{ source: 'dist/b/cli.mjs', dest: 'scripts/b-cli.mjs' }],
      skillDir: `${PROJ_ROOT}/skills/b`,
    };
    const result = DeferredArtifacts.from([skillA, skillB], PROJ_ROOT);

    expect(result.destPaths.has('skills/a/scripts/a-cli.mjs')).toBe(true);
    expect(result.destPaths.has('skills/b/scripts/b-cli.mjs')).toBe(true);
    expect(result.sourcePaths.has('dist/a/cli.mjs')).toBe(true);
    expect(result.sourcePaths.has('dist/b/cli.mjs')).toBe(true);
  });

  // ---- isEmpty ----

  it('isEmpty is true when constructed from no skills', () => {
    expect(DeferredArtifacts.from([], PROJ_ROOT).isEmpty).toBe(true);
  });

  it('isEmpty is true when the single skill has no files', () => {
    expect(fromSingleSkill([]).isEmpty).toBe(true);
  });

  it('isEmpty is false when there is at least one files entry', () => {
    const files: SkillFileEntry[] = [{ source: CLI_SOURCE, dest: CLI_DEST }];
    expect(fromSingleSkill(files).isEmpty).toBe(false);
  });
});

describe('DeferredArtifacts.covers', () => {
  it('matches an exact dest path (absolute path input)', () => {
    const files: SkillFileEntry[] = [{ source: CLI_SOURCE, dest: CLI_DEST }];
    const artifacts = fromSingleSkill(files);
    expect(artifacts.covers(safePath.join(PROJ_ROOT, CLI_DEST))).toBe(true);
  });

  it('matches an exact source path (absolute path input)', () => {
    const files: SkillFileEntry[] = [{ source: CLI_SOURCE, dest: CLI_DEST }];
    const artifacts = fromSingleSkill(files);
    expect(artifacts.covers(safePath.join(PROJ_ROOT, CLI_SOURCE))).toBe(true);
  });

  it('matches a directory-prefix child under a glob dest', () => {
    const files: SkillFileEntry[] = [{ source: GLOB_PACKS_SOURCE, dest: GLOB_PACKS_DEST }];
    const artifacts = fromSingleSkill(files);
    expect(artifacts.covers(safePath.join(PROJ_ROOT, GLOB_PACKS_DEST, 'ce', 'x.json'))).toBe(true);
  });

  it('matches a directory-prefix child under a glob source static base', () => {
    const files: SkillFileEntry[] = [{ source: GLOB_PACKS_SOURCE, dest: GLOB_PACKS_DEST }];
    const artifacts = fromSingleSkill(files);
    expect(artifacts.covers(safePath.join(PROJ_ROOT, 'dist', 'packs', 'ce', 'x.json'))).toBe(true);
  });

  it('does NOT match a sibling path that merely shares a string prefix (a/b.mjs vs a/b.mjs.bak)', () => {
    const files: SkillFileEntry[] = [{ source: 'a/b.mjs', dest: 'scripts/b.mjs' }];
    const artifacts = fromSingleSkill(files);
    expect(artifacts.covers(safePath.join(PROJ_ROOT, 'a', 'b.mjs.bak'))).toBe(false);
  });

  it('does NOT match a sibling dir that shares a dest prefix (packsX vs packs)', () => {
    const files: SkillFileEntry[] = [{ source: GLOB_PACKS_SOURCE, dest: GLOB_PACKS_DEST }];
    const artifacts = fromSingleSkill(files);
    expect(artifacts.covers(safePath.join(PROJ_ROOT, 'packsX', 'y.json'))).toBe(false);
  });

  it('returns false for a path unrelated to any declared entry', () => {
    expect(unrelatedPathArtifacts().covers(safePath.join(PROJ_ROOT, 'other', 'file.mjs'))).toBe(false);
  });
});

describe('DeferredArtifacts.coversDest', () => {
  // Narrower than .covers(): only destPaths count. This is the predicate the
  // gitignore-leak exemption (walk-link-graph.ts recordGitignoredTarget,
  // link-validator.ts gitIgnoreSafetyIssue) must use instead of .covers() — a
  // files: SOURCE that is materialized and gitignored is a real file the
  // author pointed at, and the leak signal must survive; only a files: DEST
  // (the expected gitignored state of a build artifact) is exempt.

  it('matches an exact dest path (absolute path input)', () => {
    const files: SkillFileEntry[] = [{ source: CLI_SOURCE, dest: CLI_DEST }];
    const artifacts = fromSingleSkill(files);
    expect(artifacts.coversDest(safePath.join(PROJ_ROOT, CLI_DEST))).toBe(true);
  });

  it('does NOT match a source path, even though .covers() does', () => {
    const files: SkillFileEntry[] = [{ source: CLI_SOURCE, dest: CLI_DEST }];
    const artifacts = fromSingleSkill(files);
    const sourceAbs = safePath.join(PROJ_ROOT, CLI_SOURCE);
    expect(artifacts.covers(sourceAbs)).toBe(true);
    expect(artifacts.coversDest(sourceAbs)).toBe(false);
  });

  it('matches a directory-prefix child under a glob dest', () => {
    const files: SkillFileEntry[] = [{ source: GLOB_PACKS_SOURCE, dest: GLOB_PACKS_DEST }];
    const artifacts = fromSingleSkill(files);
    expect(artifacts.coversDest(safePath.join(PROJ_ROOT, GLOB_PACKS_DEST, 'ce', 'x.json'))).toBe(true);
  });

  it('does NOT match a directory-prefix child under a glob source static base', () => {
    const files: SkillFileEntry[] = [{ source: GLOB_PACKS_SOURCE, dest: GLOB_PACKS_DEST }];
    const artifacts = fromSingleSkill(files);
    expect(artifacts.coversDest(safePath.join(PROJ_ROOT, 'dist', 'packs', 'ce', 'x.json'))).toBe(false);
  });

  it('returns false for a path unrelated to any declared entry', () => {
    expect(unrelatedPathArtifacts().coversDest(safePath.join(PROJ_ROOT, 'other', 'file.mjs'))).toBe(false);
  });
});
