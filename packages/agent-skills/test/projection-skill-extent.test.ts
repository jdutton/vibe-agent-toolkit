/* eslint-disable security/detect-non-literal-fs-filename -- every path here is under a per-test temp directory */
/**
 * zones.md §17 risk 3, run as an experiment rather than argued.
 *
 * The claim under test is that a skill bundle — VAT's most privileged extent —
 * is the generic closure primitive plus a declaration. The only assertion that
 * can falsify that is **set equality against the shipped walker**, so every test
 * below compares `SkillExtentContributor`'s membership with what `walkLinkGraph`
 * bundles for the same skill under the same `SkillPackagingConfig`. A
 * hand-written expectation would restate the implementation and prove nothing.
 *
 * ## Two corpora, and why neither is the committed fixture in place
 *
 * Both roots are **copies** of `test/fixtures/skill-files/post-build`, cloned
 * into a temp directory. Copying rather than reading in place is what keeps the
 * comparison a comparison: rooted at its real location the corpus sits inside
 * this repository, so `createProjectRegistry` would load the repo's own
 * `vibe-agent-toolkit.config.yaml` from an ancestor and the walker's last
 * cascade branch would ask the repo's git for a gitignore verdict — two ambient
 * inputs that the projection base has no equivalent of. A difference sourced
 * from either would be attributed to the primitive, which is exactly the wrong
 * conclusion.
 *
 * - **The fixture corpus** is that copy, unmodified. It exercises markdown
 *   following, a non-markdown asset, and two broken links.
 * - **The cascade corpus** is that copy with the walker's own discriminators
 *   linked into it: a navigation file, an agent-instruction file, a sibling
 *   skill's SKILL.md, a directory, and a chain deep enough to put an asset one
 *   hop past `linkFollowDepth`. The fixture set as shipped cannot reach any of
 *   those branches, and a corpus that cannot make the two answers differ would
 *   make this whole file vacuous.
 */

import { cpSync, writeFileSync } from 'node:fs';

import {
  CLOSURE_REFERENCE_UNRESOLVED,
  ContributorRegistry,
  FilesystemExtentContributor,
  ProjectionBuilder,
  blobReferencesFor,
  parseMarkdown,
  type ExtentContribution,
  type ProjectionBase,
  type ResourceRealizationRow,
  type SkillPackagingConfig,
} from '@vibe-agent-toolkit/resources';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  SKILL_EXTENT_KIND,
  SkillExtentContributor,
  skillExtentContributorId,
  skillExtentDeclaration,
} from '../src/projection/skill-extent.js';
import { createProjectRegistry } from '../src/skill-packager.js';
import { walkLinkGraph, type WalkableRegistry, type WalkLinkGraphOptions } from '../src/walk-link-graph.js';

import { setupTempDir } from './test-helpers.js';

// ============================================================================
// Constants
// ============================================================================

/** The committed corpus both roots are cloned from. */
const FIXTURE_ROOT = safePath.resolve(import.meta.dirname, 'fixtures/skill-files/post-build');

/** The skill under test, as `resource_realizations.path` spells it. */
const SKILL_REL = 'skills/tool-a/SKILL.md';

/** The skill's name — the extent's within-root discriminator. */
const SKILL_NAME = 'tool-a';

const GUIDE_REL = 'docs/guide.md';
const HELPER_REL = 'skills/shared/helper.mjs';
const CHAIN_REL = 'docs/chain.md';
const README_REL = 'docs/README.md';
const CLAUDE_REL = 'CLAUDE.md';
const SIBLING_SKILL_REL = 'skills/tool-b/SKILL.md';
const DOCS_DIR_REL = 'docs';
const CONFIG_ASSET_REL = 'templates/config.json';

/** The packager's own default when `linkFollowDepth` is absent (skill-packager.ts:580). */
const DEFAULT_DEPTH = 2;

/** Every markdown blob's content key begins here — see `computeContentKey`. */
const MARKDOWN_KEY_PREFIX = 'markdown.';

/** A config declaring nothing: the defaults path, and the packager's own. */
const DEFAULT_CONFIG: SkillPackagingConfig = {};

/** An off-tree href — the walker filters it out before resolving; the closure does not. */
const EXTERNAL_HREF = 'https://example.test/docs';

/**
 * The cascade corpus's SKILL.md.
 *
 * The fixture's four links are kept verbatim (two of them broken, which is the
 * point — a broken link is a condition on one side and an exclusion on the
 * other, and both must agree it is not a member); the last four are the
 * discriminators the fixture cannot reach.
 */
const CASCADE_SKILL_MD = `---
name: tool-a
description: A tool that uses a bundled CLI
---

# Tool A

- [bundled CLI](scripts/cli.mjs)
- [alpha data pack](packs/alpha/data.json)
- [helper script](../shared/helper.mjs)
- [guide](../../docs/guide.md)
- [navigation](../../docs/README.md)
- [repo instructions](../../CLAUDE.md)
- [sibling skill](../tool-b/SKILL.md)
- [the docs directory](../../docs)
- [an external page](${EXTERNAL_HREF})
`;

/** The cascade corpus's guide, extended with the hop that makes depth 2 reachable. */
const CASCADE_GUIDE_MD = `---
title: Usage Guide
---

# Guide

Detailed usage instructions, continued in [the chain](chain.md).
`;

/** Depth 2. Its only link is an ASSET, so it sits one hop past `linkFollowDepth`. */
const CASCADE_CHAIN_MD = `# Chain

The [shared config](../templates/config.json) this step reads.
`;

const CASCADE_README_MD = '# Docs\n\nAn index of the documents in this directory.\n';

const CASCADE_CLAUDE_MD = '# Repository instructions\n\nHow agents work in THIS repository.\n';

// ============================================================================
// Setup
// ============================================================================

const { getTempDir } = setupTempDir('projection-skill-extent-');

// ============================================================================
// Module-scope helpers
// ============================================================================

/** Order by UTF-16 code unit — never `localeCompare`, whose collation is locale-dependent. */
function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** The comparison currency: a deduplicated, deterministically ordered path set. */
function sortedPaths(paths: Iterable<string>): string[] {
  return [...new Set(paths)].sort(compareCodeUnits);
}

/** Root-relative, forward-slashed — the coordinate system realization rows use. */
function relToRoot(root: string, absolutePath: string): string {
  return toForwardSlash(safePath.relative(root, absolutePath));
}

/** Members of `left` that `right` does not have. */
function difference(left: readonly string[], right: readonly string[]): string[] {
  const other = new Set(right);
  return left.filter((path) => !other.has(path));
}

/**
 * Fill the base's `blob_references` rows — the edges the closure walks.
 *
 * Nothing shipped wires the blob layer to a population yet, so the test does it:
 * for every markdown realization, parse the file the filesystem extent already
 * keyed and file its reference candidates under that same content key. Skipping
 * this step is the vacuous-pass trap — a closure over an edge-less base returns
 * only its root, and an assertion comparing that to an empty walk would agree.
 */
async function addBlobReferences(
  builder: ProjectionBuilder,
  root: string,
  realizations: readonly ResourceRealizationRow[],
): Promise<void> {
  for (const realization of realizations) {
    const { contentKey } = realization;
    if (contentKey?.startsWith(MARKDOWN_KEY_PREFIX) !== true) continue;
    // Sequential: `parseMarkdown` reads the file, and fanning a whole corpus out
    // at once puts one handle per markdown file in flight for no shorter test.
    const parsed = await parseMarkdown(safePath.join(root, realization.path));
    for (const row of blobReferencesFor(contentKey, parsed)) {
      builder.addBlobReference(row);
    }
  }
}

/**
 * A base holding the filesystem extent plus every markdown blob's references.
 *
 * Only `resources` and `resource_realizations` are merged from the contribution:
 * the closure contributor reads realizations (to resolve a target) and blob
 * references (its edges), and nothing else. Merging the remaining tables would
 * restate `merge.ts`'s `mergeContribution` without changing any answer here.
 */
async function populatedBase(root: string): Promise<ProjectionBase> {
  const builder = new ProjectionBuilder(root);
  builder.addRoot({ id: builder.identities.rootId, path: safePath.resolve(root) });

  const contribution = await new FilesystemExtentContributor().contribute(builder.base(), null);
  for (const row of contribution.resources) {
    builder.addResource(row);
  }
  for (const row of contribution.realizations) {
    builder.addRealization(row);
  }

  await addBlobReferences(builder, root, contribution.realizations);
  return builder.base();
}

/** What `walkLinkGraph` bundles, including the skill root it never lists itself. */
async function walkerBundle(root: string, config: SkillPackagingConfig): Promise<string[]> {
  const registry = await createProjectRegistry(root);
  const skillAbsolute = safePath.resolve(safePath.join(root, SKILL_REL));
  const declaredDepth = config.linkFollowDepth ?? DEFAULT_DEPTH;
  const options: WalkLinkGraphOptions = {
    maxDepth: declaredDepth === 'full' ? Number.POSITIVE_INFINITY : declaredDepth,
    excludeRules: config.excludeReferencesFromBundle?.rules ?? [],
    projectRoot: root,
    skillRootPath: skillAbsolute,
    excludeNavigationFiles: config.excludeNavigationFiles ?? true,
  };

  const result = walkLinkGraph(
    registry.getResource(skillAbsolute)?.id ?? '',
    registry as WalkableRegistry,
    options,
  );

  // The walk's own root is bundled by construction and absent from
  // `bundledResources` (the visited set holds it before the map does), whereas
  // `closureFrom` is an admitted member. Adding it here is what makes the two
  // sets describe the same thing.
  return sortedPaths([
    SKILL_REL,
    ...result.bundledResources.map((resource) => relToRoot(root, resource.filePath)),
    ...result.bundledAssets.map((asset) => relToRoot(root, asset)),
  ]);
}

/** Run the skill extent over a populated base. */
async function skillExtent(base: ProjectionBase, config: SkillPackagingConfig): Promise<ExtentContribution> {
  const contributor = new SkillExtentContributor(SKILL_NAME);
  return contributor.contribute(base, skillExtentDeclaration(config, SKILL_REL));
}

/** The closure's membership, in the walker's currency. */
async function closureMembers(root: string, config: SkillPackagingConfig): Promise<string[]> {
  const contribution = await skillExtent(await populatedBase(root), config);
  return sortedPaths(contribution.realizations.map((row) => row.path));
}

/** Clone the committed fixture into a scratch root of its own. */
function fixtureCorpus(name: string): string {
  const root = safePath.join(getTempDir(), name);
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return root;
}

/** The fixture corpus plus the links that reach the walker's other discriminators. */
function cascadeCorpus(): string {
  const root = fixtureCorpus('cascade');
  writeFileSync(safePath.join(root, SKILL_REL), CASCADE_SKILL_MD);
  writeFileSync(safePath.join(root, GUIDE_REL), CASCADE_GUIDE_MD);
  writeFileSync(safePath.join(root, CHAIN_REL), CASCADE_CHAIN_MD);
  writeFileSync(safePath.join(root, README_REL), CASCADE_README_MD);
  writeFileSync(safePath.join(root, CLAUDE_REL), CASCADE_CLAUDE_MD);
  return root;
}

// ============================================================================
// The translation
// ============================================================================

describe('skillExtentDeclaration', () => {
  it('translates a config-less skill into the packager\'s own default depth', () => {
    const declaration = skillExtentDeclaration(DEFAULT_CONFIG, SKILL_REL);
    expect(declaration).toEqual({
      kind: SKILL_EXTENT_KIND,
      closureFrom: SKILL_REL,
      maxDepth: DEFAULT_DEPTH,
      exclude: [],
      follow: ['markdown-link', 'markdown-link-reference', 'markdown-definition'],
    });
  });

  it('carries linkFollowDepth "full" through unchanged', () => {
    expect(skillExtentDeclaration({ linkFollowDepth: 'full' }, SKILL_REL).maxDepth).toBe('full');
  });

  it('flattens every ordered rule\'s patterns into one exclude list', () => {
    const config: SkillPackagingConfig = {
      excludeReferencesFromBundle: {
        rules: [
          { patterns: ['**/*.mjs'], template: 'https://example.test/{{path}}' },
          { patterns: ['docs/**', '**/*.json'] },
        ],
      },
    };
    expect(skillExtentDeclaration(config, SKILL_REL).exclude).toEqual(['**/*.mjs', 'docs/**', '**/*.json']);
  });
});

describe('SkillExtentContributor', () => {
  it('is a closure-stratum contributor under the ids zone_provenance keys on', () => {
    const contributor = new SkillExtentContributor(SKILL_NAME);
    expect(contributor.id).toBe(skillExtentContributorId(SKILL_NAME));
    expect(contributor.kind).toBe(SKILL_EXTENT_KIND);
    expect(contributor.stratum).toBe('closure');
  });

  it('gives two skills two contributor ids, so both can register', () => {
    // A fixed id capped a population at ONE skill extent: the registry refuses
    // a duplicate, and this repo alone ships thirteen skills.
    const registry = new ContributorRegistry();

    expect(() => {
      registry.register(new SkillExtentContributor(SKILL_NAME));
      registry.register(new SkillExtentContributor('another-skill'));
    }).not.toThrow();
    expect(registry.forKind(SKILL_EXTENT_KIND)).toHaveLength(2);
  });

  it('declares one extent whose context id discriminates on the skill name', async () => {
    const contribution = await skillExtent(await populatedBase(fixtureCorpus('identity')), DEFAULT_CONFIG);
    expect(contribution.contexts).toHaveLength(1);
    expect(contribution.contexts[0]?.contextId).toContain(SKILL_NAME);
    expect(contribution.contexts[0]?.kind).toBe(SKILL_EXTENT_KIND);
  });
});

// ============================================================================
// The experiment
// ============================================================================

describe('membership against walkLinkGraph', () => {
  it('agrees exactly on the committed skill-files fixture', async () => {
    const root = fixtureCorpus('fixture');
    const closure = await closureMembers(root, DEFAULT_CONFIG);

    // Stated as well as compared: an equality that both sides could satisfy
    // while empty would be the vacuous pass this file exists to avoid.
    expect(closure).toEqual([GUIDE_REL, HELPER_REL, SKILL_REL].sort(compareCodeUnits));
    expect(closure).toEqual(await walkerBundle(root, DEFAULT_CONFIG));
  });

  it('agrees when an exclude rule drops the linked asset, both matching from the PROJECT root', async () => {
    const root = fixtureCorpus('excluded');
    // Anchored at the project root on purpose, and it is a probe as well as a
    // fixture. `ExcludeReferenceRuleSchema.patterns` is documented as "matched
    // against path relative to SKILL root" (project-config.ts:120), but
    // `walk-link-graph.ts:650` matches `safePath.relative(projectRoot, target)`
    // and `skill-packager.ts:607` passes the PROJECT root. Relative to the skill
    // root this pattern is `../shared/helper.mjs` and could not match; relative
    // to the project root it is `skills/shared/helper.mjs` and does. Both sides
    // dropping the file is therefore the doc/impl divergence, pinned.
    const config: SkillPackagingConfig = {
      excludeReferencesFromBundle: { rules: [{ patterns: ['skills/shared/*.mjs'], template: '{{path}}' }] },
    };

    const closure = await closureMembers(root, config);
    expect(closure).not.toContain(HELPER_REL);
    expect(closure).toEqual(await walkerBundle(root, config));
  });

  it('DIVERGES at linkFollowDepth 0: an asset bypasses the walker\'s depth cap', async () => {
    const root = fixtureCorpus('depth-zero');
    const config: SkillPackagingConfig = { linkFollowDepth: 0 };

    const closure = await closureMembers(root, config);
    const walker = await walkerBundle(root, config);

    // The walker's depth check lives in `processRegistryResource`, so it is
    // reached only for a REGISTRY member. A non-markdown target never gets
    // there: `processLink` adds it to `bundledAssetSet` unconditionally. The
    // primitive has one depth for every followed reference, so the asset is a
    // depth-1 hop and is refused. Same corpus, same config, different answer —
    // which is the standing proof that the fixture CAN distinguish.
    expect(difference(walker, closure)).toEqual([HELPER_REL]);
    expect(difference(closure, walker)).toEqual([]);
  });

  it('DIVERGES on every cascade discriminator the primitive has no vocabulary for', async () => {
    const root = cascadeCorpus();
    const closure = await closureMembers(root, DEFAULT_CONFIG);
    const walker = await walkerBundle(root, DEFAULT_CONFIG);

    // Admitted by the closure, refused by the walker. Each is a named branch of
    // `classifyExclusion`'s ordered cascade, and each carries a REASON the
    // primitive's `exclude` cannot express — a glob returns a verdict with no
    // payload, and an excluded target emits no row at all:
    //   docs            → `directory-target`
    //   docs/README.md  → `navigation-file` (excludeNavigationFiles)
    //   CLAUDE.md       → `agent-instruction-file`
    //   skills/tool-b/SKILL.md → `skill-definition`
    expect(difference(closure, walker)).toEqual(
      [DOCS_DIR_REL, README_REL, CLAUDE_REL, SIBLING_SKILL_REL].sort(compareCodeUnits),
    );

    // Bundled by the walker, refused by the closure: `templates/config.json` is
    // an asset linked from a depth-2 document, so it is a depth-3 hop the
    // declaration's `maxDepth: 2` refuses while the walker's asset path never
    // consults depth at all. Same feature as the depth-0 case above, reached
    // through a chain rather than through the root.
    expect(difference(walker, closure)).toEqual([CONFIG_ASSET_REL]);

    // Both sides in full, so the two differences above cannot be read as a diff
    // between sets nobody stated — and so the markdown chain both sides DO
    // agree on (`docs/guide.md` → `docs/chain.md`, depth 2) is visible as the
    // common ground it is.
    expect(walker).toEqual(sortedPaths([SKILL_REL, GUIDE_REL, CHAIN_REL, HELPER_REL, CONFIG_ASSET_REL]));
    expect(closure).toEqual(sortedPaths([
      SKILL_REL, GUIDE_REL, CHAIN_REL, HELPER_REL,
      DOCS_DIR_REL, README_REL, CLAUDE_REL, SIBLING_SKILL_REL,
    ]));
  });

  it('AGREES with walkLinkGraph on external URLs: no condition, and local breaks still recorded', async () => {
    const contribution = await skillExtent(await populatedBase(cascadeCorpus()), DEFAULT_CONFIG);
    const unresolved = contribution.conditions.filter((row) => row.code === CLOSURE_REFERENCE_UNRESOLVED);

    // `walkLinkGraph` filters on `isLocalFileLink` before it resolves anything, so an `https:`
    // href is not an edge and produces no record. The closure's edge set is `blob_references`
    // filtered by SYNTACTIC FORM, and an external URL is a `markdown-link` like any other — so
    // the scheme check has to be made explicitly, in `closure-extent.ts`'s `isNonLocalRef`,
    // before resolution. Without it the href resolves against the referring directory, finds
    // nothing realized, and records a broken *local* reference: a false claim about the document
    // that would fire on essentially every real skill.
    //
    // This assertion previously pinned the opposite — the divergence, as originally found. It
    // stayed green after the fix landed only because it reads `@vibe-agent-toolkit/resources`
    // from `dist`, and nothing had rebuilt it.
    expect(unresolved.some((row) => row.message.includes(EXTERNAL_HREF))).toBe(false);

    // The negative above is only meaningful while the condition table is live. The fixture's
    // two deliberately broken *local* links must still be recorded, or "no external URL was
    // flagged" would also be satisfied by flagging nothing at all.
    expect(unresolved.length).toBeGreaterThan(0);
    expect(unresolved.every((row) => !row.message.includes('://'))).toBe(true);
  });
});
