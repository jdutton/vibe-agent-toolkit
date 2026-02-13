import { resolve } from 'node:path';

import type { ResourceLink, ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { walkLinkGraph, type ExcludeRule, type WalkableRegistry, type WalkLinkGraphOptions } from '../src/walk-link-graph.js';

// ============================================================================
// Constants
// ============================================================================

// Use path.resolve() so paths are platform-appropriate (drive letter on Windows)
const PROJECT_ROOT = resolve('/project');
const SKILL_ID = 'skill-md';
const SKILL_PATH = resolve('/project/SKILL.md');
const GUIDE_ID = 'guide-md';
const GUIDE_PATH = resolve('/project/docs/guide.md');
const GUIDE_HREF = './docs/guide.md';
const REF_ID = 'ref-md';
const REF_PATH = resolve('/project/docs/ref.md');
const DEEP_ID = 'deep-md';
const DEEP_PATH = resolve('/project/docs/deep.md');
const README_ID = 'readme-md';
const README_PATH = resolve('/project/docs/README.md');
const README_HREF = './docs/README.md';

// Valid 64-char hex string cast to branded SHA256 type
const MOCK_CHECKSUM = 'a'.repeat(64) as ResourceMetadata['checksum'];

// ============================================================================
// Helpers — Resource & Registry Builders
// ============================================================================

function createMockResource(
  id: string,
  filePath: string,
  links: ResourceLink[] = [],
): ResourceMetadata {
  return {
    id,
    filePath,
    links,
    headings: [],
    sizeBytes: 100,
    estimatedTokenCount: 25,
    modifiedAt: new Date('2024-01-01'),
    checksum: MOCK_CHECKSUM,
  };
}

function createLocalLink(text: string, href: string, resolvedId?: string): ResourceLink {
  return {
    text,
    href,
    type: 'local_file',
    line: 1,
    ...(resolvedId === undefined ? {} : { resolvedId }),
  };
}

function createMockRegistry(resources: ResourceMetadata[]): WalkableRegistry {
  const byId = new Map(resources.map(r => [r.id, r]));
  const byPath = new Map(resources.map(r => [r.filePath, r]));
  return {
    getResourceById: (id: string) => byId.get(id),
    getResource: (path: string) => byPath.get(path),
  };
}

function defaultOptions(overrides?: Partial<WalkLinkGraphOptions>): WalkLinkGraphOptions {
  return {
    maxDepth: 5,
    excludeRules: [],
    projectRoot: PROJECT_ROOT,
    ...overrides,
  };
}

// ============================================================================
// Helpers — Common Graph Topologies
// ============================================================================

/** skill → guide (basic 2-node) */
function createSkillGuideRegistry(
  guideLink: ResourceLink = createLocalLink('guide', GUIDE_HREF, GUIDE_ID),
): WalkableRegistry {
  const skill = createMockResource(SKILL_ID, SKILL_PATH, [guideLink]);
  const guide = createMockResource(GUIDE_ID, GUIDE_PATH);
  return createMockRegistry([skill, guide]);
}

/** skill → guide → ref (3-node chain, optional extra links on ref) */
function createSkillGuideRefRegistry(refLinks: ResourceLink[] = []): WalkableRegistry {
  const skill = createMockResource(SKILL_ID, SKILL_PATH, [
    createLocalLink('guide', GUIDE_HREF, GUIDE_ID),
  ]);
  const guide = createMockResource(GUIDE_ID, GUIDE_PATH, [
    createLocalLink('ref', './ref.md', REF_ID),
  ]);
  const ref = createMockResource(REF_ID, REF_PATH, refLinks);
  return createMockRegistry([skill, guide, ref]);
}

/** skill → guide → deep (3-level depth chain) */
function createDepthChainRegistry(): WalkableRegistry {
  const skill = createMockResource(SKILL_ID, SKILL_PATH, [
    createLocalLink('guide', GUIDE_HREF, GUIDE_ID),
  ]);
  const guide = createMockResource(GUIDE_ID, GUIDE_PATH, [
    createLocalLink('deep', './deep.md', DEEP_ID),
  ]);
  const deep = createMockResource(DEEP_ID, DEEP_PATH);
  return createMockRegistry([skill, guide, deep]);
}

/** skill → README (navigation file scenario) */
function createReadmeRegistry(): WalkableRegistry {
  const skill = createMockResource(SKILL_ID, SKILL_PATH, [
    createLocalLink('readme', README_HREF, README_ID),
  ]);
  const readme = createMockResource(README_ID, README_PATH);
  return createMockRegistry([skill, readme]);
}

// ============================================================================
// Helpers — Walk & Assert
// ============================================================================

/** Walk from a lone skill (no other resources in registry) */
function walkSingleSkill(links: ResourceLink[], options?: Partial<WalkLinkGraphOptions>) {
  const skill = createMockResource(SKILL_ID, SKILL_PATH, links);
  const registry = createMockRegistry([skill]);
  return walkLinkGraph(SKILL_ID, registry, defaultOptions(options));
}

/** Assert bundled resource IDs match expected (order-independent) */
function expectBundledIds(result: ReturnType<typeof walkLinkGraph>, expectedIds: string[]): void {
  expect(result.bundledResources).toHaveLength(expectedIds.length);
  const ids = result.bundledResources.map(r => r.id);
  for (const id of expectedIds) {
    expect(ids).toContain(id);
  }
}

/** Assert walk produced no bundled resources and no excluded references */
function expectEmptyWalkResult(result: ReturnType<typeof walkLinkGraph>): void {
  expect(result.bundledResources).toHaveLength(0);
  expect(result.excludedReferences).toHaveLength(0);
}

// ============================================================================
// Tests
// ============================================================================

describe('walkLinkGraph', () => {
  describe('skill resource not found', () => {
    it('should return empty result when skill resource ID is not in registry', () => {
      const registry = createMockRegistry([]);
      const result = walkLinkGraph('nonexistent', registry, defaultOptions());

      expect(result.bundledResources).toHaveLength(0);
      expect(result.bundledAssets).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(0);
      expect(result.maxBundledDepth).toBe(0);
    });
  });

  describe('basic graph walk', () => {
    it('should bundle directly linked markdown resources', () => {
      const registry = createSkillGuideRegistry();
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      expectBundledIds(result, [GUIDE_ID]);
      expect(result.maxBundledDepth).toBe(1);
    });

    it('should walk multi-level dependency chains', () => {
      const registry = createSkillGuideRefRegistry();
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      expectBundledIds(result, [GUIDE_ID, REF_ID]);
      expect(result.maxBundledDepth).toBe(2);
    });

    it('should skip non-local_file link types', () => {
      const result = walkSingleSkill([
        { text: 'external', href: 'https://example.com', type: 'external', line: 1 },
        { text: 'section', href: '#heading', type: 'anchor', line: 2 },
      ]);

      expectEmptyWalkResult(result);
    });
  });

  describe('depth limiting', () => {
    it('should exclude resources beyond maxDepth with depth-exceeded reason', () => {
      const registry = createDepthChainRegistry();
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions({ maxDepth: 1 }));

      expectBundledIds(result, [GUIDE_ID]);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe('depth-exceeded');
      expect(result.excludedReferences[0]?.path).toBe(DEEP_PATH);
    });

    it('should bundle all levels when maxDepth is Infinity', () => {
      const registry = createDepthChainRegistry();
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions({ maxDepth: Infinity }));

      expectBundledIds(result, [GUIDE_ID, DEEP_ID]);
      expect(result.maxBundledDepth).toBe(2);
    });
  });

  describe('cycle detection', () => {
    it('should not revisit already-visited resources', () => {
      const skill = createMockResource(SKILL_ID, SKILL_PATH, [
        createLocalLink('guide', GUIDE_HREF, GUIDE_ID),
      ]);
      // guide links back to skill (cycle)
      const guide = createMockResource(GUIDE_ID, GUIDE_PATH, [
        createLocalLink('skill', '../SKILL.md', SKILL_ID),
      ]);
      const registry = createMockRegistry([skill, guide]);

      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      // guide is bundled, but skill is not re-bundled (it's the starting point)
      expectBundledIds(result, [GUIDE_ID]);
    });

    it('should handle mutual references between two resources', () => {
      const registry = createSkillGuideRefRegistry([
        createLocalLink('guide', '../guide.md', GUIDE_ID),
      ]);
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      expectBundledIds(result, [GUIDE_ID, REF_ID]);
    });
  });

  describe('navigation file exclusion', () => {
    it('should exclude README.md when excludeNavigationFiles is true', () => {
      const registry = createReadmeRegistry();
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions({ excludeNavigationFiles: true }));

      expect(result.bundledResources).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe('navigation-file');
    });

    it('should include README.md when excludeNavigationFiles is false', () => {
      const registry = createReadmeRegistry();
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions({ excludeNavigationFiles: false }));

      expectBundledIds(result, [README_ID]);
    });
  });

  describe('pattern matching', () => {
    it('should exclude files matching exclude patterns', () => {
      const rule: ExcludeRule = { patterns: ['docs/private/**'] };
      const privateId = 'private-md';
      const privatePath = resolve('/project/docs/private/secret.md');
      const skill = createMockResource(SKILL_ID, SKILL_PATH, [
        createLocalLink('secret', './docs/private/secret.md', privateId),
      ]);
      const secret = createMockResource(privateId, privatePath);
      const registry = createMockRegistry([skill, secret]);

      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions({ excludeRules: [rule] }));

      expect(result.bundledResources).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe('pattern-matched');
      expect(result.excludedReferences[0]?.matchedRule).toBe(rule);
    });
  });

  describe('link resolution fallbacks', () => {
    it('should resolve by path when resolvedId is undefined', () => {
      // No resolvedId — walkLinkGraph should fall back to getResource(targetPath)
      const registry = createSkillGuideRegistry(createLocalLink('guide', GUIDE_HREF));
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      expectBundledIds(result, [GUIDE_ID]);
    });

    it('should silently skip links to files not in registry and not on disk', () => {
      const result = walkSingleSkill([
        createLocalLink('missing', './nonexistent.md', 'no-such-id'),
      ]);

      expect(result.bundledResources).toHaveLength(0);
      expect(result.bundledAssets).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(0);
    });

    it('should skip links with empty href after anchor stripping', () => {
      // href is just an anchor but typed as local_file (edge case)
      const result = walkSingleSkill([createLocalLink('section', '#heading')]);

      expectEmptyWalkResult(result);
    });
  });

  describe('outside project boundary', () => {
    it('should exclude files outside the project root', () => {
      const result = walkSingleSkill([createLocalLink('external', '../outside/doc.md')]);

      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe('outside-project');
    });
  });

  describe('maxBundledDepth tracking', () => {
    it('should track depth across branches correctly', () => {
      // skill -> guide (depth 1) -> ref (depth 2)
      // skill -> ref2 (depth 1)
      const ref2Id = 'ref2-md';
      const ref2Path = resolve('/project/ref2.md');
      const skill = createMockResource(SKILL_ID, SKILL_PATH, [
        createLocalLink('guide', GUIDE_HREF, GUIDE_ID),
        createLocalLink('ref2', './ref2.md', ref2Id),
      ]);
      const guide = createMockResource(GUIDE_ID, GUIDE_PATH, [
        createLocalLink('ref', './ref.md', REF_ID),
      ]);
      const ref = createMockResource(REF_ID, REF_PATH);
      const ref2 = createMockResource(ref2Id, ref2Path);
      const registry = createMockRegistry([skill, guide, ref, ref2]);

      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      expectBundledIds(result, [GUIDE_ID, REF_ID, ref2Id]);
      expect(result.maxBundledDepth).toBe(2);
    });
  });
});
