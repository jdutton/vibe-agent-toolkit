import { describe, expect, it } from 'vitest';

import {
  mergeFilesConfig,
  matchLinkToFiles,
  computeDeferredPaths,
  type SkillFileEntry,
} from '../src/files-config.js';

const CLI_SOURCE = 'dist/bin/cli.mjs';
const CLI_DEST = 'scripts/cli.mjs';

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
  it('should return empty set when no files config', () => {
    expect(computeDeferredPaths([])).toEqual(new Set());
  });

  it('should include both source and dest paths', () => {
    const files: SkillFileEntry[] = [
      { source: CLI_SOURCE, dest: CLI_DEST },
    ];
    const result = computeDeferredPaths(files);
    expect(result.has(CLI_SOURCE)).toBe(true);
    expect(result.has(CLI_DEST)).toBe(true);
  });

  it('should deduplicate across multiple entries', () => {
    const files: SkillFileEntry[] = [
      { source: CLI_SOURCE, dest: CLI_DEST },
      { source: CLI_SOURCE, dest: 'scripts/cli2.mjs' },
    ];
    const result = computeDeferredPaths(files);
    expect(result.size).toBe(3);
  });
});
