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
  DeferredArtifacts,
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
  SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
  SKILL_REFUSED_DIRECTORY_TARGET,
  SKILL_REFUSED_NAVIGATION_FILE,
  SKILL_REFUSED_PATTERN_MATCHED,
  SkillExtentContributor,
  skillExtentContributorId,
  skillExtentDeclaration,
} from '../src/projection/skill-extent.js';
import { createProjectRegistry } from '../src/skill-packager.js';
import { AGENT_INSTRUCTION_FILE_PATTERNS, NAVIGATION_FILE_PATTERNS } from '../src/validators/validation-rules.js';
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

/** An explicit, non-glob `files:` source naming an agent-instruction file. */
const DECLARED_CLAUDE_SOURCE = 'notes/CLAUDE.md';
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
    // Built exactly as `skill-packager.ts:599` builds it — per skill, against
    // the skill's own directory. Without it the walker's `files:` escape hatch
    // is unreachable, and the `admitPaths` half of the translation would be
    // compared against a walker that could never have granted it.
    deferredArtifacts: DeferredArtifacts.from(
      [{ files: config.files ?? [], skillDir: safePath.join(skillAbsolute, '..') }],
      root,
    ),
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
      follow: ['markdown-link', 'markdown-link-reference', 'markdown-definition'],
      // In `classifyExclusion`'s own branch order — see the next test for why
      // that order is now behaviour rather than presentation.
      refusals: [
        // `classifyPathKind` refuses a directory unconditionally — no knob gates it.
        { label: SKILL_REFUSED_DIRECTORY_TARGET, patterns: [], basenames: [], kinds: ['directory'], flags: {} },
        // `skill-packager.ts:582` defaults `excludeNavigationFiles` to true, so a
        // config-less skill refuses this list too.
        {
          label: SKILL_REFUSED_NAVIGATION_FILE,
          patterns: [], basenames: [...NAVIGATION_FILE_PATTERNS], kinds: [], flags: {},
        },
        {
          label: SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
          patterns: [], basenames: [...AGENT_INSTRUCTION_FILE_PATTERNS], kinds: [], flags: {},
        },
        { label: SKILL_REFUSED_PATTERN_MATCHED, patterns: [], basenames: [], kinds: [], flags: {} },
      ],
      admitPaths: [],
    });
  });

  it('orders the cascade exactly as classifyExclusion does — the order IS the label', () => {
    // The primitive is first-match-wins and each rule carries a distinct label,
    // so this sequence is what decides that a directory ALSO matching an exclude
    // pattern reports `directory-target` rather than `pattern-matched` — which is
    // `classifyExclusion`'s documented behaviour (`walk-link-graph.ts`: "the
    // order IS the behaviour"). Asserted as a LIST rather than as membership: a
    // set-shaped assertion would pass against any permutation, which is exactly
    // the property under test.
    expect(skillExtentDeclaration(DEFAULT_CONFIG, SKILL_REL).refusals.map((rule) => rule.label))
      .toEqual([
        SKILL_REFUSED_DIRECTORY_TARGET,
        SKILL_REFUSED_NAVIGATION_FILE,
        SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
        SKILL_REFUSED_PATTERN_MATCHED,
      ]);
  });

  it('keeps the agent-instruction rule when excludeNavigationFiles is false, and drops only navigation', () => {
    // The walker's agent-instruction branch is deliberately NOT gated on this
    // knob (`refusesAgentInstructionFile`): the knob is about content
    // granularity, "this file is not distributable" is a different question. A
    // translation that gated both would ship every repo's CLAUDE.md the moment
    // an author asked for their READMEs back.
    const declaration = skillExtentDeclaration({ excludeNavigationFiles: false }, SKILL_REL);
    // The navigation rule is OMITTED, not emptied: the declaration says the
    // branch does not run, rather than that it runs and catches nothing.
    expect(declaration.refusals.map((rule) => rule.label)).toEqual([
      SKILL_REFUSED_DIRECTORY_TARGET,
      SKILL_REFUSED_AGENT_INSTRUCTION_FILE,
      SKILL_REFUSED_PATTERN_MATCHED,
    ]);
    const agentInstruction = declaration.refusals
      .find((rule) => rule.label === SKILL_REFUSED_AGENT_INSTRUCTION_FILE);
    expect(agentInstruction?.basenames).toEqual([...AGENT_INSTRUCTION_FILE_PATTERNS]);
    expect(declaration.refusals.flatMap((rule) => rule.basenames)).not.toContain('README.md');
  });

  it('carries linkFollowDepth "full" through unchanged', () => {
    expect(skillExtentDeclaration({ linkFollowDepth: 'full' }, SKILL_REL).maxDepth).toBe('full');
  });

  it('flattens every ordered rule\'s patterns into ONE labelled refusal rule', () => {
    // One rule, not one per `ExcludeRule`: the walker reports `pattern-matched`
    // for all of them, so splitting them would invent a distinction the reason
    // vocabulary does not have. What is lost is *which* rule won — and that is
    // only observable through its `template`, which the condition row has no
    // column for either. See the module note's `template` row.
    const config: SkillPackagingConfig = {
      excludeReferencesFromBundle: {
        rules: [
          { patterns: ['**/*.mjs'], template: 'https://example.test/{{path}}' },
          { patterns: ['docs/**', '**/*.json'] },
        ],
      },
    };
    const patternRule = skillExtentDeclaration(config, SKILL_REL).refusals
      .filter((rule) => rule.label === SKILL_REFUSED_PATTERN_MATCHED);
    expect(patternRule).toHaveLength(1);
    expect(patternRule[0]?.patterns).toEqual(['**/*.mjs', 'docs/**', '**/*.json']);
  });

  it('admits an EXPLICIT files:-declared agent-instruction source, and nothing else', () => {
    // The walker's escape hatch, mirrored. Three entries, one of which earns it:
    //   notes/CLAUDE.md   — explicit + agent-instruction  → admitted
    //   docs/README.md    — explicit, but the `navigation-file` branch sits
    //                       EARLIER in the cascade and carries NO hatch, so the
    //                       walker still refuses it and so must the closure
    //   vendor/**\/AGENTS.md — a GLOB: `DeferredArtifacts.from` registers it by
    //                       its static base, so `sourcePaths` never contains the
    //                       matched file and exact membership refuses it
    const config: SkillPackagingConfig = {
      files: [
        { source: DECLARED_CLAUDE_SOURCE, dest: DECLARED_CLAUDE_SOURCE },
        { source: README_REL, dest: README_REL },
        { source: 'vendor/**/AGENTS.md', dest: 'vendor/AGENTS.md' },
      ],
    };
    expect(skillExtentDeclaration(config, SKILL_REL).admitPaths).toEqual([DECLARED_CLAUDE_SOURCE]);
  });

  it('normalizes a files: source into projection coordinates', () => {
    // `DeferredArtifacts.from` resolves a source through
    // `relative(projectRoot, resolve(join(projectRoot, source)))`, which strips a
    // leading `./`. `admitPaths` is compared by EXACT equality against
    // `resource_realizations.path`, so an unnormalized `./notes/CLAUDE.md` would
    // match nothing at all — a silently dead escape hatch.
    const config: SkillPackagingConfig = {
      files: [{ source: `./${DECLARED_CLAUDE_SOURCE}`, dest: CLAUDE_REL }],
    };
    expect(skillExtentDeclaration(config, SKILL_REL).admitPaths).toEqual([DECLARED_CLAUDE_SOURCE]);
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

  it('AGREES on the three cascade discriminators, and now names each one', async () => {
    const root = cascadeCorpus();
    const contribution = await skillExtent(await populatedBase(root), DEFAULT_CONFIG);
    const closure = sortedPaths(contribution.realizations.map((row) => row.path));

    // Each of these was in `difference(closure, walker)` before the primitive
    // grew a labelled refusal cascade and `admitPaths`, and each is now refused
    // by exactly one rule of it.
    expect(closure).not.toContain(DOCS_DIR_REL);
    expect(closure).not.toContain(README_REL);
    expect(closure).not.toContain(CLAUDE_REL);

    // …and the REASON is reported, not just the membership. The right-hand
    // column is `classifyExclusion`'s own verdict for the same file, which the
    // corpus shadow asserts head-to-head; here the mapping is pinned at fixture
    // scale so a translation that refused the right files under the wrong label
    // fails in the package that owns the translation.
    const codeFor = (path: string): string | undefined =>
      contribution.conditions.find((row) => row.path === path)?.code;
    expect(codeFor(DOCS_DIR_REL)).toBe(SKILL_REFUSED_DIRECTORY_TARGET); // walker: directory-target
    expect(codeFor(README_REL)).toBe(SKILL_REFUSED_NAVIGATION_FILE); // walker: navigation-file
    expect(codeFor(CLAUDE_REL)).toBe(SKILL_REFUSED_AGENT_INSTRUCTION_FILE); // walker: agent-instruction-file

    // …and the walk was narrowed, not stopped. Without this the three negatives
    // above are satisfied just as well by a closure that admitted nothing — and
    // an admitted member must carry no refusal row.
    expect(closure).toContain(GUIDE_REL);
    expect(closure).toContain(CHAIN_REL);
    expect(codeFor(GUIDE_REL)).toBeUndefined();
  });

  it('reports a pattern-matched refusal under its own label, not the basename one', async () => {
    // The fourth branch, and the one the cascade order could silently mislabel:
    // `skills/shared/helper.mjs` is neither a directory nor a navigation nor an
    // agent-instruction basename, so only the LAST rule can catch it. Pinned
    // alongside the other three so all four labels this translation supplies are
    // exercised at fixture scale rather than three of four.
    const root = fixtureCorpus('pattern-labelled');
    const config: SkillPackagingConfig = {
      excludeReferencesFromBundle: { rules: [{ patterns: ['skills/shared/*.mjs'], template: '{{path}}' }] },
    };
    const contribution = await skillExtent(await populatedBase(root), config);

    expect(contribution.realizations.map((row) => row.path)).not.toContain(HELPER_REL);
    expect(contribution.conditions.find((row) => row.path === HELPER_REL)?.code)
      .toBe(SKILL_REFUSED_PATTERN_MATCHED);
  });

  it('pins resources.kind "directory" — the premise excludeKinds rests on', async () => {
    // Verified against a real crawl rather than read off the producer: if a
    // directory entity were kinded anything else, `excludeKinds: ['directory']`
    // would be a silent no-op and the assertion above would still pass for the
    // wrong reason (a directory has no markdown blob, so it contributes no
    // further edges either way).
    const base = await populatedBase(cascadeCorpus());
    const kindOf = (path: string): string | undefined => {
      const realization = base.resourceRealizations.find((row) => row.path === path);
      return base.resources.find((row) => row.resourceId === realization?.resourceId)?.kind;
    };

    expect(kindOf(DOCS_DIR_REL)).toBe('directory');
    // The discriminating half: the column would be useless if everything were a
    // directory, and `excludeKinds` would then refuse the whole corpus.
    expect(kindOf(GUIDE_REL)).toBe('file');
  });

  it('DIVERGES on the cascade discriminators the primitive still has no vocabulary for', async () => {
    const root = cascadeCorpus();
    const closure = await closureMembers(root, DEFAULT_CONFIG);
    const walker = await walkerBundle(root, DEFAULT_CONFIG);

    // Admitted by the closure, refused by the walker. `skill-definition` is the
    // one left: its verdict depends on comparing the target against THIS walk's
    // own `skillRootPath` (a self-link is skipped, a sibling's SKILL.md is
    // refused), and a declaration has no vocabulary for "the same file as my own
    // root". An equality, not a `toContain`: a NEW divergence appearing is the
    // finding this file exists to surface.
    expect(difference(closure, walker)).toEqual([SIBLING_SKILL_REL]);

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
      SKILL_REL, GUIDE_REL, CHAIN_REL, HELPER_REL, SIBLING_SKILL_REL,
    ]));
  });

  it('admits a files:-declared CLAUDE.md the same walk otherwise refuses', async () => {
    // The escape hatch, end to end. Both arms are given the same `files:`
    // declaration, so this is an agreement and not a claim about the closure
    // alone — and the un-declared run beside it is what makes the admission a
    // statement about `admitPaths` rather than about reachability.
    const root = cascadeCorpus();
    const declared: SkillPackagingConfig = {
      files: [{ source: CLAUDE_REL, dest: 'CLAUDE.md' }],
    };

    expect(await closureMembers(root, DEFAULT_CONFIG)).not.toContain(CLAUDE_REL);
    expect(await closureMembers(root, declared)).toContain(CLAUDE_REL);
    expect(await walkerBundle(root, declared)).toContain(CLAUDE_REL);
  });

  it('does NOT admit a files:-declared README.md — the navigation branch has no hatch', async () => {
    // The cascade-ORDER asymmetry, pinned on both arms. `classifyExclusion`
    // refuses `navigation-file` BEFORE it reaches the agent-instruction branch
    // that carries the hatch, so declaring a README in `files:` does not get the
    // LINK to it bundled. The translation encodes that by admitting only
    // agent-instruction sources; a translation that admitted every explicit
    // `files:` source would diverge from the walker right here.
    const root = cascadeCorpus();
    const declared: SkillPackagingConfig = {
      files: [{ source: README_REL, dest: 'README.md' }],
    };

    expect(await closureMembers(root, declared)).not.toContain(README_REL);
    expect(await walkerBundle(root, declared)).not.toContain(README_REL);
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
