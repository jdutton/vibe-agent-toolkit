/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { DeferredArtifacts } from '@vibe-agent-toolkit/resources';
import type { ResourceLink, ResourceMetadata, SkillFileEntry } from '@vibe-agent-toolkit/resources';
import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { walkLinkGraph, type ExcludeRule, type WalkableRegistry, type WalkLinkGraphOptions } from '../src/walk-link-graph.js';

import { setupTempDir } from './test-helpers.js';

// Mock isGitIgnored — default to false (not ignored), override in specific tests
vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    isGitIgnored: vi.fn().mockReturnValue(false),
  };
});

// Import after mock setup so we get the mocked version
const { isGitIgnored } = await import('@vibe-agent-toolkit/utils');

// ============================================================================
// Constants
// ============================================================================

// Use path.resolve() so paths are platform-appropriate (drive letter on Windows)
const PROJECT_ROOT = safePath.resolve('/project');
const SKILL_ID = 'skill-md';
const SKILL_PATH = safePath.resolve('/project/SKILL.md');
const GUIDE_ID = 'guide-md';
const GUIDE_PATH = safePath.resolve('/project/docs/guide.md');
const GUIDE_HREF = './docs/guide.md';
const REF_ID = 'ref-md';
const REF_PATH = safePath.resolve('/project/docs/ref.md');
const DEEP_ID = 'deep-md';
const DEEP_PATH = safePath.resolve('/project/docs/deep.md');
const README_ID = 'readme-md';
const README_PATH = safePath.resolve('/project/docs/README.md');
const README_HREF = './docs/README.md';

// Valid 64-char hex string cast to branded SHA256 type
const MOCK_CHECKSUM = 'a'.repeat(64) as ResourceMetadata['checksum'];

// Exclude reason literals — avoid string duplication in assertions
const REASON_SKILL_DEFINITION = 'skill-definition';
const REASON_MISSING_TARGET = 'missing-target';
const REASON_AGENT_INSTRUCTION = 'agent-instruction-file';

/** Href whose target is never created on disk — the broken-link subject. */
const MISSING_HREF = './docs/gone.md';

// Deferred paths constants — used in "deferred files support" tests
const DEFERRED_DEST_REL = 'scripts/cli.mjs';
const DEFERRED_SRC_REL = 'dist/bin/cli.mjs';

// Filename literal used in the real-disk deferred test
const EXISTING_SOURCE_MJS = 'existing-source.mjs';

// ============================================================================
// Setup — temp dir for tests that need real on-disk files
// ============================================================================

const { getTempDir } = setupTempDir('walk-link-graph-test-');

// ============================================================================
// Module-scope helpers
// ============================================================================

/** Default deferred artifacts: one files: entry (source dist/bin/cli.mjs → dest scripts/cli.mjs). */
function makeDeferredArtifacts(): DeferredArtifacts {
  return DeferredArtifacts.from(
    [{ files: [{ source: DEFERRED_SRC_REL, dest: DEFERRED_DEST_REL }], skillDir: PROJECT_ROOT }],
    PROJECT_ROOT,
  );
}

/**
 * Build a DeferredArtifacts whose destPaths/sourcePaths are exactly the given
 * project-root-relative rel paths — used where a test wants to isolate one
 * side (e.g. dest-only) without the other side's placeholder entry
 * accidentally matching a real test link target.
 */
function makeDeferredArtifactsFromRelPaths(
  opts: { destPaths?: string[]; sourcePaths?: string[]; skillDir?: string; projectRoot?: string } = {},
): DeferredArtifacts {
  const skillDir = opts.skillDir ?? PROJECT_ROOT;
  const projectRoot = opts.projectRoot ?? PROJECT_ROOT;
  const files: SkillFileEntry[] = [
    ...(opts.destPaths ?? []).map((dest, i) => ({ dest, source: `__unused-source-${i}__` })),
    ...(opts.sourcePaths ?? []).map((source, i) => ({ dest: `__unused-dest-${i}__`, source })),
  ];
  return DeferredArtifacts.from([{ files, skillDir }], projectRoot);
}

/**
 * Walk a single skill→link graph rooted at a real on-disk temp dir, with the
 * given deferred dest/source sets. Shared by the on-disk deferred tests so the
 * walk-option block is written once.
 */
function walkOnDiskDeferred(opts: {
  tmpDir: string;
  linkText: string;
  linkRel: string;
  destPaths?: string[];
  sourcePaths?: string[];
}): ReturnType<typeof walkLinkGraph> {
  const skill = createMockResource(SKILL_ID, safePath.join(opts.tmpDir, 'SKILL.md'), [
    createLocalLink(opts.linkText, `./${opts.linkRel}`),
  ]);
  const registry = createMockRegistry([skill]);
  return walkLinkGraph(SKILL_ID, registry, {
    maxDepth: 5,
    excludeRules: [],
    projectRoot: opts.tmpDir,
    skillRootPath: safePath.join(opts.tmpDir, 'SKILL.md'),
    deferredArtifacts: makeDeferredArtifactsFromRelPaths({
      destPaths: opts.destPaths,
      sourcePaths: opts.sourcePaths,
      skillDir: opts.tmpDir,
      projectRoot: opts.tmpDir,
    }),
  });
}

/**
 * skill → docs/guide.md → docs/ref.md, with every file REALLY on disk under a
 * fresh temp root.
 *
 * The gitignore fixtures must be real. A `gitignored` exclusion is only
 * meaningful for a target that EXISTS — a path that isn't there is a broken
 * link, whatever the ignore oracle says about it. Fictional paths used to work
 * here only because the walker consulted the oracle before checking existence,
 * i.e. because of the very defect these tests now pin.
 */
function createOnDiskChain(): {
  root: string;
  skillPath: string;
  guidePath: string;
  refPath: string;
  registry: WalkableRegistry;
} {
  const root = getTempDir();
  const skillPath = safePath.resolve(root, 'SKILL.md');
  const guidePath = safePath.resolve(root, 'docs/guide.md');
  const refPath = safePath.resolve(root, 'docs/ref.md');
  mkdirSyncReal(dirname(guidePath), { recursive: true });
  writeFileSync(skillPath, '# Skill\n');
  writeFileSync(guidePath, '# Guide\n');
  writeFileSync(refPath, '# Ref\n');

  const skill = createMockResource(SKILL_ID, skillPath, [createLocalLink('guide', GUIDE_HREF, GUIDE_ID)]);
  const guide = createMockResource(GUIDE_ID, guidePath, [createLocalLink('ref', './ref.md', REF_ID)]);
  const ref = createMockResource(REF_ID, refPath);
  return { root, skillPath, guidePath, refPath, registry: createMockRegistry([skill, guide, ref]) };
}

/** Project-relative path of the on-disk agent-instruction file a `files:` entry may declare. */
const DECLARED_CLAUDE_REL = 'docs/CLAUDE.md';
const DECLARED_CLAUDE_ID = 'declared-claude-md';

/**
 * Write `docs/CLAUDE.md` for real and walk a link to it with the given `files:`
 * source declarations.
 *
 * A real on-disk fixture is mandatory here. A fictional path is `!existsSync`,
 * which makes `checkDeferred` classify it as a not-yet-built artifact BEFORE the
 * agent-instruction branch is reached — the rows would then pass without the
 * branch under test ever running.
 */
function walkDeclaredAgentInstruction(sources: string[]): ReturnType<typeof walkLinkGraph> {
  const tmpDir = getTempDir();
  const target = safePath.resolve(tmpDir, DECLARED_CLAUDE_REL);
  mkdirSyncReal(dirname(target), { recursive: true });
  writeFileSync(target, '# Repo guidance\n');

  const skillPath = safePath.resolve(tmpDir, 'SKILL.md');
  writeFileSync(skillPath, '# Skill\n');
  const skill = createMockResource(SKILL_ID, skillPath, [
    createLocalLink('guidance', `./${DECLARED_CLAUDE_REL}`, DECLARED_CLAUDE_ID),
  ]);
  const registry = createMockRegistry([skill, createMockResource(DECLARED_CLAUDE_ID, target)]);

  return walkLinkGraph(SKILL_ID, registry, {
    maxDepth: 5,
    excludeRules: [],
    projectRoot: tmpDir,
    skillRootPath: skillPath,
    deferredArtifacts: makeDeferredArtifactsFromRelPaths({
      sourcePaths: sources,
      skillDir: tmpDir,
      projectRoot: tmpDir,
    }),
  });
}

/**
 * Shared fixture for the materialized-and-gitignored dest pair: an on-disk,
 * gitignored `data/index.json`. Only whether deferredArtifacts covers it
 * (via destPaths) differs between the two tests that use it.
 */
function createGitignoredDestFixture(): { tmpDir: string; destRel: string } {
  const tmpDir = getTempDir();
  const destRel = 'data/index.json';
  const destFile = safePath.resolve(tmpDir, destRel);
  mkdirSyncReal(dirname(destFile), { recursive: true });
  writeFileSync(destFile, '{}\n');
  vi.mocked(isGitIgnored).mockImplementation((filePath: string) => filePath === destFile);
  return { tmpDir, destRel };
}

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
    skillRootPath: SKILL_PATH,
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

/** skill → an agent-instruction file (CLAUDE.md / AGENTS.md / GEMINI.md) */
function createAgentInstructionRegistry(basename: string): WalkableRegistry {
  const id = `agent-instruction-${basename}`;
  const skill = createMockResource(SKILL_ID, SKILL_PATH, [
    createLocalLink('guidance', `./docs/${basename}`, id),
  ]);
  const target = createMockResource(id, safePath.resolve(`/project/docs/${basename}`));
  return createMockRegistry([skill, target]);
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

/**
 * Build a skill→child link graph and run walkLinkGraph with a single exclude
 * rule. Shared between exclude-pattern tests to avoid scenario duplication.
 */
function runExcludeScenario(args: {
  rule: ExcludeRule;
  childHref: string;
  childAbsPath: string;
  childId: string;
}): ReturnType<typeof walkLinkGraph> {
  const skill = createMockResource(SKILL_ID, SKILL_PATH, [
    createLocalLink('secret', args.childHref, args.childId),
  ]);
  const secret = createMockResource(args.childId, args.childAbsPath);
  const registry = createMockRegistry([skill, secret]);
  return walkLinkGraph(SKILL_ID, registry, defaultOptions({ excludeRules: [args.rule] }));
}

// ============================================================================
// Tests
// ============================================================================

afterEach(() => {
  vi.mocked(isGitIgnored).mockReturnValue(false);
});

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

  describe('agent instruction file exclusion', () => {
    it.each(['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'GEMINI.md'])(
      'should exclude %s from the bundle',
      (basename) => {
        const registry = createAgentInstructionRegistry(basename);
        const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

        expect(result.bundledResources).toHaveLength(0);
        expect(result.excludedReferences).toHaveLength(1);
        expect(result.excludedReferences[0]?.excludeReason).toBe(REASON_AGENT_INSTRUCTION);
      },
    );

    it('should exclude agent instruction files even when excludeNavigationFiles is false', () => {
      // These files are repo-internal guidance, not content at the wrong
      // granularity. The navigation-file opt-out must not reopen the door.
      const registry = createAgentInstructionRegistry('CLAUDE.md');
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions({ excludeNavigationFiles: false }));

      expect(result.bundledResources).toHaveLength(0);
      expect(result.excludedReferences[0]?.excludeReason).toBe(REASON_AGENT_INSTRUCTION);
    });

    it('should not treat an ordinary doc with a similar name as agent instructions', () => {
      const registry = createAgentInstructionRegistry('CLAUDE-setup.md');
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      expectBundledIds(result, ['agent-instruction-CLAUDE-setup.md']);
    });

    // The precedence this pins: naming a file in `files:` is an unambiguous
    // instruction to ship it, so the link to it must be FOLLOWED (bundled through
    // the path map, which the entry re-points at the declared dest). Refusing the
    // link anyway is what made the code's own remedy unsatisfiable — the author
    // declared the file, it shipped, and the build still failed telling them to
    // declare it. A GLOB earns nothing here: it never named the file it caught.
    //
    // Real on-disk fixtures are mandatory. A fictional path is `!existsSync`, which
    // makes `checkDeferred` classify it as a not-yet-built artifact BEFORE the
    // agent-instruction branch is reached — the test would then pass without the
    // branch under test ever running.
    describe('explicit files: declaration', () => {
      it('bundles an agent-instruction file an EXPLICIT files: source names', () => {
        const result = walkDeclaredAgentInstruction([DECLARED_CLAUDE_REL]);

        expectBundledIds(result, [DECLARED_CLAUDE_ID]);
        expect(result.excludedReferences).toHaveLength(0);
      });

      it('still excludes an agent-instruction file only a files: GLOB caught', () => {
        // `docs/**/*` registers its STATIC BASE (`docs`) as the source path, so the
        // file is a prefix child of the declaration rather than the declaration.
        const result = walkDeclaredAgentInstruction(['docs/**/*']);

        expect(result.bundledResources).toHaveLength(0);
        expect(result.excludedReferences).toHaveLength(1);
        expect(result.excludedReferences[0]?.excludeReason).toBe(REASON_AGENT_INSTRUCTION);
      });
    });
  });

  describe('pattern matching', () => {
    it('should exclude files matching exclude patterns', () => {
      const rule: ExcludeRule = { patterns: ['docs/private/**'] };
      const result = runExcludeScenario({
        rule,
        childHref: './docs/private/secret.md',
        childAbsPath: safePath.resolve('/project/docs/private/secret.md'),
        childId: 'private-md',
      });

      expect(result.bundledResources).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe('pattern-matched');
      expect(result.excludedReferences[0]?.matchedRule).toBe(rule);
    });

    // Regression guard: picomatch defaults silently exclude paths traversing
    // dotfile segments (.claude/, .worktrees/, .config/). Without dot:true on
    // the exclude matcher, rules like `**/private/**` never fire for links
    // under `.claude/...` and references aren't dropped from the bundle.
    it('should exclude files under dotfile-prefixed directories', () => {
      const result = runExcludeScenario({
        rule: { patterns: ['**/private/**'] },
        childHref: './.claude/private/secret.md',
        childAbsPath: safePath.resolve('/project/.claude/private/secret.md'),
        childId: 'private-dot-md',
      });

      expect(result.bundledResources).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe('pattern-matched');
    });
  });

  describe('link resolution fallbacks', () => {
    it('should resolve by path when resolvedId is undefined', () => {
      // No resolvedId — walkLinkGraph should fall back to getResource(targetPath)
      const registry = createSkillGuideRegistry(createLocalLink('guide', GUIDE_HREF));
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      expectBundledIds(result, [GUIDE_ID]);
    });

    it('should record missing-target exclusion for links to files not in registry and not on disk', () => {
      const result = walkSingleSkill([
        createLocalLink('missing', './nonexistent.md', 'no-such-id'),
      ]);

      expect(result.bundledResources).toHaveLength(0);
      expect(result.bundledAssets).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe(REASON_MISSING_TARGET);
      expect(result.excludedReferences[0]?.path).toContain('nonexistent.md');
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

    // An absolute-path reference (RFC 3986 §4.2 — a leading `/`) resolves against
    // the PROJECT ROOT, which is what `resolveLocalHref` has always done for the
    // resources lane. The walker used to resolve every href with
    // `resolve(dirname(source), href)`, and `path.resolve` DISCARDS its base when
    // the second argument is absolute: `/docs/guide.md` came back as the
    // filesystem-root path `/docs/guide.md`, which is outside every project root
    // that is not `/`. Every root-absolute link in a walked file therefore became
    // a `LINK_OUTSIDE_PROJECT` error against a target that exists and is in the
    // registry. Measured on a real monorepo: 81 such errors, all false.
    it('resolves a root-absolute link against the project root, not the filesystem root', () => {
      const skill = createMockResource(SKILL_ID, SKILL_PATH, [
        createLocalLink('guide', '/docs/guide.md', GUIDE_ID),
      ]);
      const guide = createMockResource(GUIDE_ID, GUIDE_PATH);
      const registry = createMockRegistry([skill, guide]);

      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      expect(result.excludedReferences).toHaveLength(0);
      expectBundledIds(result, [GUIDE_ID]);
    });

    // The boundary must still hold for a root-absolute href: `/../escape.md`
    // resolves ABOVE the project root and must not be bundled just because the
    // resolver now honours the leading slash.
    it('still excludes a root-absolute link that escapes the project root', () => {
      const result = walkSingleSkill([createLocalLink('escape', '/../outside/doc.md')]);

      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe('outside-project');
    });
  });

  describe('maxBundledDepth tracking', () => {
    it('should track depth across branches correctly', () => {
      // skill -> guide (depth 1) -> ref (depth 2)
      // skill -> ref2 (depth 1)
      const ref2Id = 'ref2-md';
      const ref2Path = safePath.resolve('/project/ref2.md');
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

  describe('cross-skill SKILL.md exclusion', () => {
    it('should exclude links to other SKILL.md files as skill-definition', () => {
      const otherSkillId = 'other-skill-md';
      const otherSkillPath = safePath.resolve('/project/other-skill/SKILL.md');
      const skill = createMockResource(SKILL_ID, SKILL_PATH, [
        createLocalLink('guide', GUIDE_HREF, GUIDE_ID),
        createLocalLink('other skill', './other-skill/SKILL.md', otherSkillId),
      ]);
      const guide = createMockResource(GUIDE_ID, GUIDE_PATH);
      const otherSkill = createMockResource(otherSkillId, otherSkillPath);
      const registry = createMockRegistry([skill, guide, otherSkill]);

      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      // Guide should be bundled, other SKILL.md should NOT
      expectBundledIds(result, [GUIDE_ID]);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe(REASON_SKILL_DEFINITION);
      expect(result.excludedReferences[0]?.path).toBe(otherSkillPath);
    });

    it('should exclude SKILL.md found via transitive link', () => {
      // skill -> guide -> other-skill/SKILL.md
      const otherSkillId = 'other-skill-md';
      const otherSkillPath = safePath.resolve('/project/other-skill/SKILL.md');
      const skill = createMockResource(SKILL_ID, SKILL_PATH, [
        createLocalLink('guide', GUIDE_HREF, GUIDE_ID),
      ]);
      const guide = createMockResource(GUIDE_ID, GUIDE_PATH, [
        createLocalLink('other skill', '../other-skill/SKILL.md', otherSkillId),
      ]);
      const otherSkill = createMockResource(otherSkillId, otherSkillPath);
      const registry = createMockRegistry([skill, guide, otherSkill]);

      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      expectBundledIds(result, [GUIDE_ID]);
      expect(result.excludedReferences.some(r => r.excludeReason === REASON_SKILL_DEFINITION)).toBe(true);
    });

    it('should not exclude non-SKILL.md files named similarly', () => {
      // Ensure files like "MY-SKILL.md" or "skills.md" are not caught
      const skillsDocId = 'skills-doc';
      const skillsDocPath = safePath.resolve('/project/docs/skills.md');
      const skill = createMockResource(SKILL_ID, SKILL_PATH, [
        createLocalLink('skills doc', './docs/skills.md', skillsDocId),
      ]);
      const skillsDoc = createMockResource(skillsDocId, skillsDocPath);
      const registry = createMockRegistry([skill, skillsDoc]);

      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      expectBundledIds(result, [skillsDocId]);
      expect(result.excludedReferences).toHaveLength(0);
    });

    it('should NOT emit skill-definition for a bundled doc linking back to the current skill\'s own SKILL.md', () => {
      // Mirrors the real adopter scenario:
      //   skill at /project/skills/repo-setup/SKILL.md
      //     links to ../../docs/platform-packages.md (bundled)
      //   that doc contains a back-link to ../../skills/repo-setup/SKILL.md
      //     (the same skill — NOT another skill)
      //
      // The walker should silently drop the self-link (already visited via cycle guard)
      // without producing a skill-definition exclusion, because it isn't a different
      // skill and bundling is not at risk — this is the skill itself.
      const ownSkillPath = safePath.resolve('/project/skills/repo-setup/SKILL.md');
      const docPath = safePath.resolve('/project/docs/platform-packages.md');
      const docId = 'platform-packages';

      const skill = createMockResource(SKILL_ID, ownSkillPath, [
        createLocalLink('platform packages', '../../docs/platform-packages.md', docId),
      ]);
      const doc = createMockResource(docId, docPath, [
        createLocalLink('repo-setup skill', '../skills/repo-setup/SKILL.md', SKILL_ID),
      ]);
      const registry = createMockRegistry([skill, doc]);

      const result = walkLinkGraph(
        SKILL_ID,
        registry,
        defaultOptions({ skillRootPath: ownSkillPath }),
      );

      // Doc bundled; no skill-definition exclusion for the self-link.
      expectBundledIds(result, [docId]);
      expect(
        result.excludedReferences.some(r => r.excludeReason === REASON_SKILL_DEFINITION),
      ).toBe(false);
    });
  });

  // ============================================================================
  // Gitignored file exclusion
  // ============================================================================

  describe('gitignored file exclusion', () => {
    it('should exclude gitignored markdown files with gitignored reason', () => {
      const { root, skillPath, guidePath, registry } = createOnDiskChain();
      vi.mocked(isGitIgnored).mockImplementation((filePath: string) => filePath === guidePath);

      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions({
        projectRoot: root,
        skillRootPath: skillPath,
      }));

      expect(result.bundledResources).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe('gitignored');
      expect(result.excludedReferences[0]?.path).toBe(guidePath);
      // The record carries the evidence the verdict engine gates on, so a
      // downstream front-end never has to assume existence.
      expect(result.excludedReferences[0]?.targetExists).toBe(true);
      // Verify projectRoot is passed as cwd so git checks ignore rules in the right directory
      expect(vi.mocked(isGitIgnored)).toHaveBeenCalledWith(guidePath, root);
    });

    it('should NOT exclude files that are not gitignored', () => {
      // isGitIgnored returns false by default (from mock setup)
      const registry = createSkillGuideRegistry();
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      expectBundledIds(result, [GUIDE_ID]);
      expect(result.excludedReferences).toHaveLength(0);
    });

    it('should exclude gitignored file found via transitive link', () => {
      // skill -> guide -> ref, where ref is gitignored
      const { root, skillPath, refPath, registry } = createOnDiskChain();
      vi.mocked(isGitIgnored).mockImplementation((filePath: string) => filePath === refPath);

      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions({
        projectRoot: root,
        skillRootPath: skillPath,
      }));

      // Guide should be bundled, but ref should be excluded as gitignored
      expectBundledIds(result, [GUIDE_ID]);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe('gitignored');
      expect(result.excludedReferences[0]?.path).toBe(refPath);
    });

    // ------------------------------------------------------------------
    // The ordering defect: ignore-before-existence names the wrong cause.
    // ------------------------------------------------------------------

    it('reports a MISSING target as missing-target even when the ignore oracle calls it ignored', () => {
      // Neither oracle can be trusted about a path that is not there.
      // GitTracker's active set holds only paths that DO exist, so a typo'd
      // link is trivially absent and therefore "ignored"; `git check-ignore`
      // answers from patterns, so a never-built `dist/out.js` is "ignored"
      // too. Asked before existence, either one renames every broken link to
      // LINK_TO_GITIGNORED_FILE — an accusation about a file that is not there.
      vi.mocked(isGitIgnored).mockReturnValue(true);

      const result = walkSingleSkill([createLocalLink('gone', MISSING_HREF)]);

      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe(REASON_MISSING_TARGET);
      expect(result.excludedReferences[0]?.targetExists).toBe(false);
    });

    it('does not consult the ignore oracle at all for a missing target', () => {
      // Stronger than the verdict: the oracle is not even asked. Keeps a future
      // refactor from reintroducing the question and papering over the answer.
      // (No clearMocks in the vitest config — call history is per-file, so
      // clear it explicitly rather than inheriting earlier tests' calls.)
      vi.mocked(isGitIgnored).mockClear().mockReturnValue(true);

      walkSingleSkill([createLocalLink('gone', MISSING_HREF)]);

      expect(vi.mocked(isGitIgnored)).not.toHaveBeenCalled();
    });

    it('never asks a GitTracker about a target that does not exist', () => {
      // The real-repo oracle. `vat audit` plumbs a pre-populated GitTracker
      // through, and its active set answers "ignored" for anything absent.
      const asked: string[] = [];
      const tracker = {
        isIgnoredByActiveSet: (p: string) => {
          asked.push(p);
          return true;
        },
      } as unknown as NonNullable<WalkLinkGraphOptions['gitTracker']>;

      const result = walkSingleSkill(
        [createLocalLink('gone', MISSING_HREF)],
        { gitTracker: tracker },
      );

      expect(asked).toEqual([]);
      expect(result.excludedReferences[0]?.excludeReason).toBe(REASON_MISSING_TARGET);
    });
  });

  // ============================================================================
  // Deferred files support
  // ============================================================================

  describe('deferred files support', () => {
    it.each([
      { label: 'dest', linkText: 'CLI', linkRel: DEFERRED_DEST_REL },
      { label: 'source', linkText: 'CLI src', linkRel: DEFERRED_SRC_REL },
    ])('$label missing on disk → deferred (in deferredAssets, absent from excludedReferences)', ({ linkText, linkRel }) => {
      const skill = createMockResource(SKILL_ID, SKILL_PATH, [
        createLocalLink(linkText, `./${linkRel}`),
      ]);
      const registry = createMockRegistry([skill]);

      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions({
        deferredArtifacts: makeDeferredArtifacts(),
      }));

      expect(result.deferredAssets).toHaveLength(1);
      expect(result.deferredAssets[0]).toContain(linkRel);
      // Must NOT appear in excludedReferences
      expect(result.excludedReferences).toHaveLength(0);
    });

    it('source that EXISTS on disk (not in destPaths) → NOT deferred → bundled as normal asset', () => {
      // Create a real temp file to simulate a source that exists on disk (not a build artifact)
      const tmpDir = getTempDir();
      writeFileSync(safePath.join(tmpDir, EXISTING_SOURCE_MJS), '// existing source\n');

      // EXISTING_SOURCE_MJS is in sourcePaths, but the file EXISTS → must NOT defer
      const result = walkOnDiskDeferred({
        tmpDir,
        linkText: 'existing CLI src',
        linkRel: EXISTING_SOURCE_MJS,
        sourcePaths: [EXISTING_SOURCE_MJS],
      });

      // File exists on disk and is in sourcePaths → bundled as normal asset, NOT deferred
      expect(result.deferredAssets).toHaveLength(0);
      expect(result.bundledAssets).toHaveLength(1);
      expect(result.bundledAssets[0]).toContain(EXISTING_SOURCE_MJS);
      expect(result.excludedReferences).toHaveLength(0);
    });

    // Existence parity for the `checkDeferred` not-yet-exists path (carry-forward
    // #1): the destPaths branch must be guarded by !existsSync just like the
    // sourcePaths branch, same as before. But an EXISTING gitignored files:
    // target is the expected post-build state of a materialized artifact, not a
    // leak — the gitignore branch in checkExclusions carries its OWN,
    // unconditional exemption for deferredArtifacts-covered paths (existing or
    // not). See the negative-control test below for the uncovered case, which
    // must still report the leak.
    it('dest that EXISTS on disk and is gitignored, covered by deferredArtifacts → deferred (no gitignored exclusion)', () => {
      const { tmpDir, destRel } = createGitignoredDestFixture();

      const result = walkOnDiskDeferred({ tmpDir, linkText: 'index', linkRel: destRel, destPaths: [destRel] });

      expect(result.deferredAssets).toHaveLength(1);
      expect(result.deferredAssets[0]).toContain(destRel);
      expect(result.excludedReferences).toHaveLength(0);
    });

    // The gitignore exemption is DEST-only (it was once broader than the defect it
    // fixed): a files: SOURCE that EXISTS on disk and is gitignored must NOT be
    // exempted — only a DEST gets the "expected post-build state" exemption. A
    // source is a real file the author pointed at; the leak signal must survive.
    it('source (not dest) that EXISTS on disk and is gitignored, covered ONLY by sourcePaths → still excluded as gitignored', () => {
      const { tmpDir, destRel: srcRel } = createGitignoredDestFixture();

      const result = walkOnDiskDeferred({ tmpDir, linkText: 'index', linkRel: srcRel, sourcePaths: [srcRel] });

      expect(result.deferredAssets).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe('gitignored');
    });

    // Negative control: the exemption is scoped to deferredArtifacts-covered
    // paths only. An existing gitignored target that is NOT declared under
    // files: (even though a deferredArtifacts model is present, from an
    // unrelated files: entry) must still surface the leak signal.
    it('dest that EXISTS on disk and is gitignored but NOT covered by deferredArtifacts → still excluded as gitignored', () => {
      const { tmpDir, destRel } = createGitignoredDestFixture();

      // No destPaths/sourcePaths passed — deferredArtifacts is present but empty,
      // so it does not cover destRel.
      const result = walkOnDiskDeferred({ tmpDir, linkText: 'index', linkRel: destRel });

      expect(result.deferredAssets).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe('gitignored');
    });

    it('dest that EXISTS on disk as a directory → NOT deferred → excluded as directory-target', () => {
      const tmpDir = getTempDir();
      const destRel = 'assets';
      mkdirSyncReal(safePath.resolve(tmpDir, destRel), { recursive: true });

      const result = walkOnDiskDeferred({ tmpDir, linkText: 'assets', linkRel: destRel, destPaths: [destRel] });

      expect(result.deferredAssets).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe('directory-target');
    });

    it('no deferredArtifacts option → deferredAssets empty', () => {
      const skill = createMockResource(SKILL_ID, SKILL_PATH, [
        createLocalLink('guide', GUIDE_HREF, GUIDE_ID),
      ]);
      const guide = createMockResource(GUIDE_ID, GUIDE_PATH);
      const registry = createMockRegistry([skill, guide]);

      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions());

      expect(result.deferredAssets).toEqual([]);
    });

    it('genuinely missing path not in either set → missing-target exclusion', () => {
      const skill = createMockResource(SKILL_ID, SKILL_PATH, [
        createLocalLink('missing', './nowhere/gone.txt'),
      ]);
      const registry = createMockRegistry([skill]);

      // deferredArtifacts provided but 'nowhere/gone.txt' is not in either set
      const result = walkLinkGraph(SKILL_ID, registry, defaultOptions({
        deferredArtifacts: makeDeferredArtifacts(),
      }));

      expect(result.deferredAssets).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe(REASON_MISSING_TARGET);
    });

    // Glob prefix deferral constants
    const GLOB_DEST_DIR = 'packs';
    const GLOB_SRC_BASE = 'dist/packs';
    // Shared walk options: only the dest dir 'packs' is a deferred (glob) prefix.
    const DEST_ONLY_DEFERRED: Partial<WalkLinkGraphOptions> = {
      deferredArtifacts: makeDeferredArtifactsFromRelPaths({ destPaths: [GLOB_DEST_DIR] }),
    };

    // Glob dest-prefix deferral: a link to 'packs/ce/x.json' under a glob entry whose
    // dest dir is 'packs' must be treated as deferred when the dest doesn't exist on disk.
    it('glob dest-prefix: link under dest dir → deferred (absent build artifact)', () => {
      const result = walkSingleSkill(
        [createLocalLink('pack asset', `./${GLOB_DEST_DIR}/ce/x.json`)],
        DEST_ONLY_DEFERRED,
      );

      expect(result.deferredAssets).toHaveLength(1);
      expect(result.deferredAssets[0]).toContain(GLOB_DEST_DIR);
      expect(result.excludedReferences).toHaveLength(0);
    });

    // Glob source-base prefix deferral: a link to 'dist/packs/ce/x.json' under a glob
    // entry whose source static base is 'dist/packs' must be treated as deferred when
    // the file doesn't exist on disk.
    it('glob source-base prefix: link under source static base → deferred (absent build artifact)', () => {
      const result = walkSingleSkill(
        [createLocalLink('pack src', `./${GLOB_SRC_BASE}/ce/x.json`)],
        { deferredArtifacts: makeDeferredArtifactsFromRelPaths({ sourcePaths: [GLOB_SRC_BASE] }) },
      );

      expect(result.deferredAssets).toHaveLength(1);
      expect(result.deferredAssets[0]).toContain(GLOB_SRC_BASE);
      expect(result.excludedReferences).toHaveLength(0);
    });

    // The +/ guard: 'packsX/y.json' must NOT match a destPaths entry of 'packs'
    it('glob prefix +/ guard: sibling dir packsX does NOT match dest packs', () => {
      const result = walkSingleSkill(
        [createLocalLink('sibling', './packsX/y.json')],
        DEST_ONLY_DEFERRED,
      );

      // Not deferred — falls through to missing-target
      expect(result.deferredAssets).toHaveLength(0);
      expect(result.excludedReferences).toHaveLength(1);
      expect(result.excludedReferences[0]?.excludeReason).toBe(REASON_MISSING_TARGET);
    });
  });
});
