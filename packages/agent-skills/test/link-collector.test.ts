/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import fs from 'node:fs';
import path from 'node:path';

import { setupAsyncTempDirSuite, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { collectLinks } from '../src/link-collector.js';
import type { ExcludeRule, LinkCollectionOptions } from '../src/link-collector.js';

// ============================================================================
// Constants
// ============================================================================

const DEPTH_EXCEEDED = 'depth-exceeded' as const;
const PATTERN_MATCHED = 'pattern-matched' as const;
const SCHEMA_JSON = 'schema.json';
const SKILL_MD_FILENAME = 'SKILL.md';
const TEST_SKILL_HEADING = '# Test Skill';

// ============================================================================
// Test Fixture Helpers
// ============================================================================

/**
 * Default options for tests -- no excludes, full depth, strip-to-text default
 */
function makeOptions(
  skillRoot: string,
  overrides: Partial<LinkCollectionOptions> = {},
): LinkCollectionOptions {
  return {
    maxDepth: Infinity,
    excludeRules: [],
    defaultRule: {},
    skillRoot,
    ...overrides,
  };
}

/**
 * Create the standard test fixture structure:
 *
 *   SKILL.md links to: level1.md, schema.json
 *   level1.md links to: level2.md, schema.json
 *   level2.md links to: level3.md
 *   level3.md has no links
 *   schema.json is a non-markdown JSON file
 */
function createStandardFixture(tempDir: string): string {
  const skillPath = path.join(tempDir, SKILL_MD_FILENAME);

  fs.writeFileSync(skillPath, [
    '---',
    'name: test-skill',
    'description: A test skill for link collection',
    '---',
    '',
    TEST_SKILL_HEADING,
    '',
    'See [level1](./level1.md) for details.',
    '',
    'Config: [schema](./schema.json)',
  ].join('\n'));

  fs.writeFileSync(path.join(tempDir, 'level1.md'), [
    '# Level 1',
    '',
    'See [level2](./level2.md) for more.',
    '',
    'Config: [schema](./schema.json)',
  ].join('\n'));

  fs.writeFileSync(path.join(tempDir, 'level2.md'), [
    '# Level 2',
    '',
    'See [level3](./level3.md) for details.',
  ].join('\n'));

  fs.writeFileSync(path.join(tempDir, 'level3.md'), [
    '# Level 3',
    '',
    'End of the chain.',
  ].join('\n'));

  fs.writeFileSync(
    path.join(tempDir, SCHEMA_JSON),
    JSON.stringify({ type: 'object' }),
  );

  return skillPath;
}

/**
 * Normalize paths in results for cross-platform comparison.
 * Converts absolute paths to forward-slash relative paths from tempDir.
 */
function relativize(absolutePaths: string[], tempDir: string): string[] {
  return absolutePaths.map((p) => toForwardSlash(path.relative(tempDir, p))).sort((a, b) => a.localeCompare(b));
}

// ============================================================================
// Tests
// ============================================================================

describe('collectLinks', () => {
  const suite = setupAsyncTempDirSuite('link-collector');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  // --------------------------------------------------------------------------
  // Test 1: maxDepth 2, no excludes
  // --------------------------------------------------------------------------
  it('should bundle files within depth 2 and exclude level3 as depth-exceeded', async () => {
    const skillPath = createStandardFixture(tempDir);
    const options = makeOptions(tempDir, { maxDepth: 2 });

    const result = await collectLinks(skillPath, options);

    // Bundled: level1.md, level2.md, schema.json (deduped from SKILL.md and level1.md)
    expect(relativize(result.bundledFiles, tempDir)).toEqual(
      ['level1.md', 'level2.md', SCHEMA_JSON],
    );

    // Excluded: level3.md (depth-exceeded)
    expect(result.excludedReferences).toHaveLength(1);
    expect(result.excludedReferences[0]?.excludeReason).toBe(DEPTH_EXCEEDED);
    expect(toForwardSlash(path.relative(tempDir, result.excludedReferences[0]?.path ?? ''))).toBe('level3.md');

    // Max bundled depth: 2 (SKILL -> level1 -> level2)
    expect(result.maxBundledDepth).toBe(2);
  });

  // --------------------------------------------------------------------------
  // Test 2: maxDepth 1, no excludes
  // --------------------------------------------------------------------------
  it('should bundle only direct links at maxDepth 1', async () => {
    const skillPath = createStandardFixture(tempDir);
    const options = makeOptions(tempDir, { maxDepth: 1 });

    const result = await collectLinks(skillPath, options);

    // Bundled: level1.md and schema.json (from SKILL.md direct links)
    // level1.md links to level2.md and schema.json, but level2.md is at depth 1 which
    // means it IS bundled (depth check: 0 < 1 for level1's links passes, so we recurse
    // into level1, and then at depth 1 we check: 1 >= 1 is TRUE, so level2 is excluded)
    // Wait -- depth semantics: SKILL.md links are at depth 0. Level1's links are at depth 1.
    // maxDepth: 1 means at depth 1, check: 1 >= 1 is TRUE → level2 is excluded.
    expect(relativize(result.bundledFiles, tempDir)).toEqual(
      ['level1.md', SCHEMA_JSON],
    );

    // Excluded: level2.md (depth-exceeded at depth 1)
    expect(result.excludedReferences).toHaveLength(1);
    expect(result.excludedReferences[0]?.excludeReason).toBe(DEPTH_EXCEEDED);
    expect(toForwardSlash(path.relative(tempDir, result.excludedReferences[0]?.path ?? ''))).toBe('level2.md');

    expect(result.maxBundledDepth).toBe(1);
  });

  // --------------------------------------------------------------------------
  // Test 3: maxDepth 0, no excludes
  // --------------------------------------------------------------------------
  it('should bundle only non-markdown assets at maxDepth 0', async () => {
    const skillPath = createStandardFixture(tempDir);
    const options = makeOptions(tempDir, { maxDepth: 0 });

    const result = await collectLinks(skillPath, options);

    // At maxDepth 0, SKILL.md is processed but its markdown links are excluded.
    // Non-markdown assets (schema.json) are still bundled because they bypass depth.
    expect(relativize(result.bundledFiles, tempDir)).toEqual([SCHEMA_JSON]);

    // Excluded: level1.md (depth-exceeded at depth 0)
    expect(result.excludedReferences).toHaveLength(1);
    expect(result.excludedReferences[0]?.excludeReason).toBe(DEPTH_EXCEEDED);
    expect(toForwardSlash(path.relative(tempDir, result.excludedReferences[0]?.path ?? ''))).toBe('level1.md');

    expect(result.maxBundledDepth).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test 4: maxDepth Infinity ('full'), no excludes
  // --------------------------------------------------------------------------
  it('should bundle all reachable files at infinite depth', async () => {
    const skillPath = createStandardFixture(tempDir);
    const options = makeOptions(tempDir);

    const result = await collectLinks(skillPath, options);

    expect(relativize(result.bundledFiles, tempDir)).toEqual(
      ['level1.md', 'level2.md', 'level3.md', SCHEMA_JSON],
    );

    expect(result.excludedReferences).toHaveLength(0);
    expect(result.maxBundledDepth).toBe(3);
  });

  // --------------------------------------------------------------------------
  // Test 5: maxDepth 2, exclude '**/level1.md'
  // --------------------------------------------------------------------------
  it('should exclude pattern-matched files and not recurse into them', async () => {
    const skillPath = createStandardFixture(tempDir);
    const excludeRule: ExcludeRule = {
      patterns: ['**/level1.md'],
    };
    const options = makeOptions(tempDir, {
      maxDepth: 2,
      excludeRules: [excludeRule],
    });

    const result = await collectLinks(skillPath, options);

    // level1 is excluded by pattern; level2 and level3 are unreachable (never recursed into level1)
    // schema.json is still bundled (linked directly from SKILL.md, not excluded by pattern)
    expect(relativize(result.bundledFiles, tempDir)).toEqual([SCHEMA_JSON]);

    // Only level1 in excludedReferences (pattern-matched)
    expect(result.excludedReferences).toHaveLength(1);
    expect(result.excludedReferences[0]?.excludeReason).toBe(PATTERN_MATCHED);
    expect(result.excludedReferences[0]?.matchedRule).toBe(excludeRule);
    expect(toForwardSlash(path.relative(tempDir, result.excludedReferences[0]?.path ?? ''))).toBe('level1.md');

    // maxBundledDepth: 0 (only schema.json which is non-markdown at depth 0)
    expect(result.maxBundledDepth).toBe(0);
  });

  // --------------------------------------------------------------------------
  // Test 6: maxDepth 2, exclude '**/schema.json'
  // --------------------------------------------------------------------------
  it('should exclude non-markdown assets by pattern and preserve each occurrence', async () => {
    const skillPath = createStandardFixture(tempDir);
    const excludeRule: ExcludeRule = {
      patterns: ['**/schema.json'],
      template: 'Search for: {{linkText}}',
    };
    const options = makeOptions(tempDir, {
      maxDepth: 2,
      excludeRules: [excludeRule],
    });

    const result = await collectLinks(skillPath, options);

    // Bundled: level1.md, level2.md (schema.json excluded by pattern, level3.md depth-exceeded)
    expect(relativize(result.bundledFiles, tempDir)).toEqual(
      ['level1.md', 'level2.md'],
    );

    // Excluded: schema.json x2 (from SKILL.md and level1.md) + level3.md (depth-exceeded)
    expect(result.excludedReferences).toHaveLength(3);

    const schemaExclusions = result.excludedReferences.filter(
      (ref) => ref.excludeReason === PATTERN_MATCHED,
    );
    expect(schemaExclusions).toHaveLength(2);
    for (const exclusion of schemaExclusions) {
      expect(toForwardSlash(path.relative(tempDir, exclusion.path))).toBe(SCHEMA_JSON);
      expect(exclusion.matchedRule).toBe(excludeRule);
    }

    const depthExclusions = result.excludedReferences.filter(
      (ref) => ref.excludeReason === DEPTH_EXCEEDED,
    );
    expect(depthExclusions).toHaveLength(1);
    expect(toForwardSlash(path.relative(tempDir, depthExclusions[0]?.path ?? ''))).toBe('level3.md');

    expect(result.maxBundledDepth).toBe(2);
  });

  // --------------------------------------------------------------------------
  // Test 7: Circular reference
  // --------------------------------------------------------------------------
  it('should handle circular references without infinite loops', async () => {
    const aPath = path.join(tempDir, 'a.md');
    const bPath = path.join(tempDir, 'b.md');

    fs.writeFileSync(aPath, [
      '---',
      'name: circular-test',
      'description: Test circular references in link collection',
      '---',
      '',
      '# A',
      '',
      'See [B](./b.md).',
    ].join('\n'));

    fs.writeFileSync(bPath, [
      '# B',
      '',
      'See [A](./a.md).',
    ].join('\n'));

    const options = makeOptions(tempDir);
    const result = await collectLinks(aPath, options);

    // Both files should be bundled: b.md is found from a.md, and a.md is found
    // from b.md's back-link. The visited set prevents infinite recursion, but
    // the link from b.md -> a.md still adds a.md to bundledFiles.
    expect(relativize(result.bundledFiles, tempDir)).toEqual(['a.md', 'b.md']);
    expect(result.excludedReferences).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Test 8: Non-existent link target
  // --------------------------------------------------------------------------
  it('should silently skip non-existent link targets', async () => {
    const skillPath = path.join(tempDir, SKILL_MD_FILENAME);

    fs.writeFileSync(skillPath, [
      '---',
      'name: missing-link-test',
      'description: Test handling of non-existent link targets',
      '---',
      '',
      TEST_SKILL_HEADING,
      '',
      'See [exists](./exists.md) and [missing](./missing.md).',
    ].join('\n'));

    fs.writeFileSync(path.join(tempDir, 'exists.md'), '# Exists\n\nThis file exists.');

    const options = makeOptions(tempDir);
    const result = await collectLinks(skillPath, options);

    // Only exists.md is bundled; missing.md is silently skipped
    expect(relativize(result.bundledFiles, tempDir)).toEqual(['exists.md']);
    expect(result.excludedReferences).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // Additional edge cases
  // --------------------------------------------------------------------------

  describe('edge cases', () => {
    it('should enforce package boundary when packageRoot is set', async () => {
      // Create a subdirectory as the "package root"
      const packageRoot = path.join(tempDir, 'pkg');
      fs.mkdirSync(packageRoot, { recursive: true });

      const skillPath = path.join(packageRoot, SKILL_MD_FILENAME);
      fs.writeFileSync(skillPath, [
        '---',
        'name: boundary-test',
        'description: Test package boundary enforcement',
        '---',
        '',
        '# Test',
        '',
        'See [inside](./inside.md) and [outside](../outside.md).',
      ].join('\n'));

      fs.writeFileSync(path.join(packageRoot, 'inside.md'), '# Inside\n\nInside the boundary.');
      fs.writeFileSync(path.join(tempDir, 'outside.md'), '# Outside\n\nOutside the boundary.');

      const options = makeOptions(packageRoot, { packageRoot });
      const result = await collectLinks(skillPath, options);

      // Only inside.md should be bundled; outside.md is beyond package boundary
      expect(relativize(result.bundledFiles, packageRoot)).toEqual(['inside.md']);
      expect(result.excludedReferences).toHaveLength(0);
    });

    it('should handle anchor-only links by skipping them', async () => {
      const skillPath = path.join(tempDir, SKILL_MD_FILENAME);

      fs.writeFileSync(skillPath, [
        '---',
        'name: anchor-test',
        'description: Test anchor-only link handling',
        '---',
        '',
        TEST_SKILL_HEADING,
        '',
        'Jump to [section](#my-section).',
        '',
        '## My Section',
        '',
        'Content here.',
      ].join('\n'));

      const options = makeOptions(tempDir);
      const result = await collectLinks(skillPath, options);

      // Anchor-only links are classified as 'anchor' type, not 'local_file',
      // so they should be completely ignored.
      expect(result.bundledFiles).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(0);
    });

    it('should handle files with links to files with anchors', async () => {
      const skillPath = path.join(tempDir, SKILL_MD_FILENAME);

      fs.writeFileSync(skillPath, [
        '---',
        'name: anchor-ref-test',
        'description: Test file links with anchors',
        '---',
        '',
        TEST_SKILL_HEADING,
        '',
        'See [section](./target.md#heading).',
      ].join('\n'));

      fs.writeFileSync(path.join(tempDir, 'target.md'), '# Target\n\n## Heading\n\nContent.');

      const options = makeOptions(tempDir);
      const result = await collectLinks(skillPath, options);

      // target.md should be bundled (anchor stripped for resolution)
      expect(relativize(result.bundledFiles, tempDir)).toEqual(['target.md']);
    });

    it('should handle empty skill file with no links', async () => {
      const skillPath = path.join(tempDir, SKILL_MD_FILENAME);

      fs.writeFileSync(skillPath, [
        '---',
        'name: empty-test',
        'description: Test empty skill file handling',
        '---',
        '',
        '# Empty Skill',
        '',
        'No links here.',
      ].join('\n'));

      const options = makeOptions(tempDir);
      const result = await collectLinks(skillPath, options);

      expect(result.bundledFiles).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(0);
      expect(result.maxBundledDepth).toBe(0);
    });

    it('should use first matching exclude rule when multiple rules could match', async () => {
      const skillPath = path.join(tempDir, SKILL_MD_FILENAME);

      fs.writeFileSync(skillPath, [
        '---',
        'name: multi-rule-test',
        'description: Test exclude rule ordering',
        '---',
        '',
        '# Test',
        '',
        'See [target](./target.md).',
      ].join('\n'));

      fs.writeFileSync(path.join(tempDir, 'target.md'), '# Target');

      const firstRule: ExcludeRule = {
        patterns: ['**/*.md'],
        template: 'First rule',
      };
      const secondRule: ExcludeRule = {
        patterns: ['**/target.md'],
        template: 'Second rule',
      };

      const options = makeOptions(tempDir, {
        excludeRules: [firstRule, secondRule],
      });

      const result = await collectLinks(skillPath, options);

      // First matching rule wins
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.matchedRule).toBe(firstRule);
      expect(result.excludedReferences[0]?.matchedRule?.template).toBe('First rule');
    });

    it('should preserve linkText and linkHref in excluded references', async () => {
      const skillPath = createStandardFixture(tempDir);
      const options = makeOptions(tempDir, { maxDepth: 1 });

      const result = await collectLinks(skillPath, options);

      // level2.md is excluded as depth-exceeded from level1.md
      const excluded = result.excludedReferences[0];
      expect(excluded).toBeDefined();
      expect(excluded?.linkText).toBe('level2');
      expect(excluded?.linkHref).toBe('./level2.md');
    });

    it('should handle subdirectory structures', async () => {
      const docsDir = path.join(tempDir, 'docs');
      fs.mkdirSync(docsDir, { recursive: true });

      const skillPath = path.join(tempDir, SKILL_MD_FILENAME);

      fs.writeFileSync(skillPath, [
        '---',
        'name: subdir-test',
        'description: Test subdirectory link resolution',
        '---',
        '',
        '# Test',
        '',
        'See [guide](./docs/guide.md).',
      ].join('\n'));

      fs.writeFileSync(path.join(docsDir, 'guide.md'), [
        '# Guide',
        '',
        'See [reference](./reference.md).',
      ].join('\n'));

      fs.writeFileSync(path.join(docsDir, 'reference.md'), '# Reference');

      const options = makeOptions(tempDir);
      const result = await collectLinks(skillPath, options);

      expect(relativize(result.bundledFiles, tempDir)).toEqual(
        ['docs/guide.md', 'docs/reference.md'],
      );
      expect(result.maxBundledDepth).toBe(2);
    });
  });
});
