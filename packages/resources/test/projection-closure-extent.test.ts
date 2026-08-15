import { createHash } from 'node:crypto';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { ExtentContribution } from '../src/projection/contributor.js';
import {
  CLOSURE_DEPTH_EXCEEDED,
  CLOSURE_REFERENCE_OUTSIDE_ROOT,
  CLOSURE_REFERENCE_UNRESOLVED,
  CLOSURE_ROOT_ABSENT,
  ClosureExtentContributor,
} from '../src/projection/contributors/closure-extent.js';
import { extentContextId } from '../src/projection/contributors/context-id.js';
import { rootIdFor } from '../src/projection/identity.js';
import { ProjectionBuilder, type ProjectionBase } from '../src/projection/projection.js';
import { ExtentDeclarationSchema, ProjectConfigSchema } from '../src/schemas/project-config.js';
import type { BlobReferenceRow, ReferenceSyntacticForm } from '../src/schemas/projection-blobs.js';
import { CONDITION_WITHOUT_REFERENCE } from '../src/schemas/projection-resources.js';
import type { ResourceRealizationRow } from '../src/schemas/projection-resources.js';
import type { JsonValue } from '../src/schemas/projection-shared.js';

import { expectContributionRowsValid } from './test-helpers.js';

/**
 * A root that is never touched on disk.
 *
 * Deliberately not under `/tmp` (`sonarjs/publicly-writable-directories` rejects
 * the literal whatever the test does with it), and deliberately never created:
 * this contributor reads the base projection and resolves paths lexically, so a
 * fixture that needed files on disk would be testing the wrong thing.
 */
const ROOT = '/vat-corpus/closure-fixture';

/** The `resolution_contexts.kind` every declaration below names. */
const SKILL_KIND = 'skill';

/** The extent name — the within-root discriminator of the closure extent's id. */
const EXTENT_NAME = 'my-skill-bundle';

/** The extent the hand-built base realizes its files in. */
const BASE_EXTENT = 'ctx-filesystem-fixture';

const ROOT_DOC = 'skills/foo/SKILL.md';
const DOC_B = 'skills/foo/b.md';
const DOC_C = 'skills/foo/c.md';
const DOC_TEST = 'skills/foo/b.test.md';

/**
 * A navigation hub spelled in a case NO entry of any pattern list contains.
 *
 * `Readme.md` is the single most common real spelling and is deliberately
 * neither `README.md` nor `readme.md`: a case-SENSITIVE implementation of
 * `excludeBasenames` admits it, so this fixture is what makes the matcher's case
 * folding falsifiable rather than merely asserted.
 */
const DOC_HUB = 'skills/foo/Readme.md';

/** Reachable ONLY through {@link DOC_HUB} — the subtree a refusal must prune. */
const DOC_BEHIND = 'skills/foo/behind.md';

/** A DIRECTORY entity, whose path is shaped exactly like a file's. */
const DOC_DIR = 'skills/foo/nested';

/** The `resources.kind` a directory entity carries — see the empirical pin in agent-skills. */
const DIRECTORY_KIND = 'directory';

/** The canonical basename spelling the declaration is authored with. */
const README_PATTERN = 'README.md';

/** The href the fixtures author for {@link DOC_HUB} — a DIFFERENT casing, deliberately. */
const README_REF = 'Readme.md';

/** A glob naming {@link DOC_HUB} by path, for the cases that refuse it by pattern. */
const README_GLOB = 'skills/**/Readme.md';

/**
 * Labels the fixtures below hand the primitive.
 *
 * Deliberately NOT the skill translation's `SKILL_REFUSED_*` vocabulary: the
 * primitive is supposed to treat a label as opaque, so a fixture that reused
 * the one real caller's spellings could not tell "reported verbatim" apart from
 * "recognised and re-emitted".
 */
const LABEL_BASENAME = 'FIXTURE_BASENAME_REFUSAL';
const LABEL_KIND = 'FIXTURE_KIND_REFUSAL';
const LABEL_GLOB = 'FIXTURE_GLOB_REFUSAL';

/** One refusal rule, with the two matchers a case never names left empty. */
function refusalRule(label: string, matchers: Record<string, JsonValue>): Record<string, JsonValue> {
  return { label, ...matchers };
}

const MARKDOWN_LINK: ReferenceSyntacticForm = 'markdown-link';

/** One reference candidate to plant in a fixture blob. */
interface FixtureRef {
  rawRef: string;
  syntacticForm?: ReferenceSyntacticForm;
  inFence?: boolean;
}

/** One fixture file: a path in the base extent plus the references its blob holds. */
interface FixtureFile {
  path: string;
  refs: readonly FixtureRef[];
  /** The `resources.kind` this entity gets. Defaults to `file`. */
  kind?: string;
  /**
   * Boolean realization columns overriding the defaults, for `flags` rules.
   *
   * A `Partial` of the row rather than named booleans, so a column added to
   * `ResourceRealizationRow` becomes fixture-settable without touching this
   * type — the same reason the matcher itself is keyed by column name.
   */
  columns?: Partial<Pick<ResourceRealizationRow, 'exists' | 'gitignored' | 'isSymlink'>>;
}

/** A schema-valid content key (`<parserKind>.<sha256>`) derived from a seed. */
function markdownKey(seed: string): string {
  return `markdown.${createHash('sha256').update(seed).digest('hex')}`;
}

/** The realization row the base carries for one fixture path. */
function realizationRow(resourceId: string, path: string, contentKey: string): ResourceRealizationRow {
  const lastSlash = path.lastIndexOf('/');
  const basename = lastSlash === -1 ? path : path.slice(lastSlash + 1);
  const dot = basename.lastIndexOf('.');
  return {
    resourceId,
    extentId: BASE_EXTENT,
    path,
    pathLower: path.toLowerCase(),
    basenameLower: basename.toLowerCase(),
    dir: lastSlash === -1 ? '' : path.slice(0, lastSlash),
    // eslint-disable-next-line local/no-hardcoded-path-split -- fixture paths are authored forward-slashed, as `relativize()` emits them
    depth: path.split('/').length,
    ext: dot <= 0 ? '' : basename.slice(dot).toLowerCase(),
    contentKey,
    // Non-null key, so the only state the schema's superRefine admits.
    contentState: 'keyed',
    mtime: null,
    exists: true,
    isDirectory: false,
    gitignored: false,
    isSymlink: false,
    symlinkResolves: null,
  };
}

/** One `blob_references` row for a planted reference. */
function referenceRow(blob: string, ordinal: number, ref: FixtureRef): BlobReferenceRow {
  return {
    blob,
    ordinal,
    rawRef: ref.rawRef,
    text: null,
    line: ordinal + 1,
    column: 1,
    syntacticForm: ref.syntacticForm ?? MARKDOWN_LINK,
    hasExtension: true,
    leadingAt: false,
    slashCount: 0,
    variableExpansion: null,
    inCodeSpan: false,
    inFence: ref.inFence ?? false,
  };
}

/** Add one fixture file's resource, realization and reference rows to the base. */
function addFile(builder: ProjectionBuilder, file: FixtureFile): void {
  const resourceId = builder.identities.idFor(safePath.join(ROOT, file.path));
  const contentKey = markdownKey(file.path);
  builder.addResource({
    resourceId,
    kind: file.kind ?? 'file',
    origin: 'filesystem',
    observed: true,
    fromEnumeration: true,
    vatId: null,
  });
  builder.addRealization({ ...realizationRow(resourceId, file.path, contentKey), ...file.columns });
  for (const [ordinal, ref] of file.refs.entries()) {
    builder.addBlobReference(referenceRow(contentKey, ordinal, ref));
  }
}

/** A base projection holding exactly these files and their reference candidates. */
function buildBase(files: readonly FixtureFile[]): ProjectionBase {
  const builder = new ProjectionBuilder(ROOT);
  for (const file of files) {
    addFile(builder, file);
  }
  return builder.base();
}

/** A chain `SKILL.md → b.md → c.md`, so depth 2 is genuinely reachable. */
const CHAIN: readonly FixtureFile[] = [
  { path: ROOT_DOC, refs: [{ rawRef: 'b.md' }] },
  { path: DOC_B, refs: [{ rawRef: 'c.md' }] },
  { path: DOC_C, refs: [] },
];

/**
 * `SKILL.md → Readme.md → behind.md`, plus an ordinary sibling.
 *
 * The hub is the only route to {@link DOC_BEHIND}, so a fixture that checked
 * only the hub could not see the pruning — which is the behaviour that accounts
 * for the overwhelming majority of the shadow experiment's divergence.
 * `DOC_B` is the control: it must survive every refusal below, or "the matcher
 * refused something" would also be satisfied by a walk that refused everything.
 */
const HUB_CHAIN: readonly FixtureFile[] = [
  { path: ROOT_DOC, refs: [{ rawRef: README_REF }, { rawRef: 'b.md' }] },
  { path: DOC_HUB, refs: [{ rawRef: 'behind.md' }] },
  { path: DOC_BEHIND, refs: [] },
  { path: DOC_B, refs: [] },
];

/** `SKILL.md` linking a DIRECTORY and an ordinary file, side by side. */
const DIRECTORY_FIXTURE: readonly FixtureFile[] = [
  { path: ROOT_DOC, refs: [{ rawRef: 'nested' }, { rawRef: 'b.md' }] },
  { path: DOC_DIR, refs: [], kind: DIRECTORY_KIND },
  { path: DOC_B, refs: [] },
];

/** Label for the boolean-column matcher's fixtures — opaque to the primitive, like the rest. */
const LABEL_FLAG = 'FIXTURE_FLAG_REFUSAL';

/**
 * `SKILL.md → Readme.md → behind.md` with the HUB marked `gitignored`, plus two
 * controls the conjunction depends on.
 *
 * The hub is spelled `Readme.md` only because {@link HUB_CHAIN} already reaches
 * `behind.md` through it; NO declaration below names a basename, so the refusal
 * under test is the column and nothing else.
 *
 * - `DOC_B` is `gitignored: false` — the control that keeps "refused something"
 *   from also being satisfied by a walk that refused everything.
 * - `DOC_C` is `gitignored: true, exists: false` — the control for the AND. A
 *   disjunctive reading of `{ gitignored: true, exists: true }` refuses it (and
 *   also refuses `DOC_B`, which exists); only a conjunctive reading admits it.
 */
const FLAG_FIXTURE: readonly FixtureFile[] = [
  { path: ROOT_DOC, refs: [{ rawRef: README_REF }, { rawRef: 'b.md' }, { rawRef: 'c.md' }] },
  { path: DOC_HUB, refs: [{ rawRef: 'behind.md' }], columns: { gitignored: true } },
  { path: DOC_BEHIND, refs: [] },
  { path: DOC_B, refs: [] },
  { path: DOC_C, refs: [], columns: { gitignored: true, exists: false } },
];

/** A cycle `SKILL.md → b.md → c.md → SKILL.md`, which only the visited set can terminate. */
const CYCLE: readonly FixtureFile[] = [
  { path: ROOT_DOC, refs: [{ rawRef: 'b.md' }] },
  { path: DOC_B, refs: [{ rawRef: 'c.md' }] },
  { path: DOC_C, refs: [{ rawRef: 'SKILL.md' }] },
];

/**
 * Another root document, under a DIFFERENT extent — the sibling that makes the
 * self-link cases falsifiable.
 *
 * A fixture with only a self-link cannot tell "a reference to the extent's own
 * root is skipped" from "the rule was dropped": both admit everything and record
 * nothing. This path is caught by the very same basename rule, so every case
 * below asserts one silence AND one refusal.
 */
const DOC_SIBLING_ROOT = 'skills/bar/SKILL.md';

/** The basename both root documents share — what a `skill-definition` rule refuses. */
const ROOT_BASENAME = 'SKILL.md';

/**
 * `SKILL.md → b.md`, and `b.md` links BACK to the root and ACROSS to a sibling
 * root.
 *
 * The two references differ in exactly one respect — which root document they
 * name — so any verdict that treats them alike is visible.
 */
const SELF_LINK: readonly FixtureFile[] = [
  { path: ROOT_DOC, refs: [{ rawRef: 'b.md' }] },
  { path: DOC_B, refs: [{ rawRef: 'SKILL.md' }, { rawRef: '../bar/SKILL.md' }] },
  { path: DOC_SIBLING_ROOT, refs: [] },
];

/** A reference climbing out of {@link ROOT} entirely, as authored. */
const OUTSIDE_REF = '../../../outside/x.md';

/**
 * The same target, as `relativize` spells it against the root — `..`-prefixed,
 * because there is no root-relative spelling of a path outside the root.
 *
 * It is what `walkLinkGraph`'s `outside-project` row names too, once that row's
 * absolute path is stated against the same root.
 */
const OUTSIDE_PATH = '../outside/x.md';

/**
 * A declaration as it arrives from config: a plain JSON value, never a
 * `z.infer` type. The merge driver's `parameters` record is `JsonValue`-typed,
 * and that is the only door the shape comes through.
 */
function declarationOf(extra: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return { kind: SKILL_KIND, closureFrom: ROOT_DOC, ...extra };
}

/** Run the contributor over a fixture base. */
async function contributeOver(
  files: readonly FixtureFile[],
  declaration: JsonValue,
): Promise<ExtentContribution> {
  const contributor = new ClosureExtentContributor(EXTENT_NAME, SKILL_KIND);
  return contributor.contribute(buildBase(files), declaration);
}

/** The paths this contribution realizes, in the order the walk admitted them. */
function memberPaths(contribution: ExtentContribution): string[] {
  return contribution.realizations.map((row) => row.path);
}

/**
 * The condition code recorded for one path, or undefined when none was.
 *
 * The refusal's whole payload, read the way a consumer would: `code` is where
 * the matched rule's label lands.
 */
function conditionCodeFor(contribution: ExtentContribution, path: string): string | undefined {
  return contribution.conditions.find((row) => row.path === path)?.code;
}

describe('ExtentDeclarationSchema', () => {
  it('rejects an unknown key', () => {
    expect(() => ExtentDeclarationSchema.parse({
      kind: SKILL_KIND,
      closureFrom: ROOT_DOC,
      followDepth: 3,
    })).toThrow();
  });

  it('requires closureFrom', () => {
    expect(() => ExtentDeclarationSchema.parse({ kind: SKILL_KIND })).toThrow();
  });

  it('accepts maxDepth as an integer or as "full", matching linkFollowDepth', () => {
    expect(ExtentDeclarationSchema.parse(declarationOf({ maxDepth: 3 })).maxDepth).toBe(3);
    expect(ExtentDeclarationSchema.parse(declarationOf({ maxDepth: 'full' })).maxDepth).toBe('full');
  });

  it('defaults an unbounded closure over the markdown forms', () => {
    const parsed = ExtentDeclarationSchema.parse(declarationOf());
    expect(parsed.maxDepth).toBe('full');
    expect(parsed.follow).toContain(MARKDOWN_LINK);
  });

  it('defaults the refusal cascade and the override to empty, so neither ever bites', () => {
    const parsed = ExtentDeclarationSchema.parse(declarationOf());
    expect(parsed.refusals).toEqual([]);
    expect(parsed.admitPaths).toEqual([]);
  });

  it('defaults every matcher of a declared rule, so naming one leaves the others inert', () => {
    const parsed = ExtentDeclarationSchema.parse(declarationOf({
      refusals: [refusalRule(LABEL_KIND, { kinds: [DIRECTORY_KIND] })],
    }));
    expect(parsed.refusals[0]).toEqual({
      label: LABEL_KIND, patterns: [], basenames: [], kinds: [DIRECTORY_KIND], flags: {}, payload: null,
    });
  });

  it('REQUIRES a label on every refusal rule — a payload-free refusal is the old shape', () => {
    expect(() => ExtentDeclarationSchema.parse(declarationOf({
      refusals: [{ kinds: [DIRECTORY_KIND] }],
    }))).toThrow();
    expect(() => ExtentDeclarationSchema.parse(declarationOf({
      refusals: [{ label: '', kinds: [DIRECTORY_KIND] }],
    }))).toThrow();
  });

  it('rejects the pre-cascade flat fields outright — no alias, no compat shim', () => {
    // Pre-1.0: `exclude`, `excludeBasenames` and `excludeKinds` were REPLACED by
    // `refusals`, not deprecated alongside it. `.strict()` is what turns a stale
    // config into an error instead of a silently ignored narrowing — the failure
    // mode where an adopter's exclusions quietly stop applying.
    for (const stale of ['exclude', 'excludeBasenames', 'excludeKinds']) {
      expect(() => ExtentDeclarationSchema.parse(declarationOf({ [stale]: ['x'] }))).toThrow();
    }
  });

  it('is reachable from ProjectConfigSchema as an extents record keyed by name', () => {
    const config = ProjectConfigSchema.parse({
      version: 1,
      extents: {
        [EXTENT_NAME]: {
          kind: SKILL_KIND,
          closureFrom: ROOT_DOC,
          follow: [MARKDOWN_LINK, 'markdown-link-reference'],
          maxDepth: 3,
          refusals: [refusalRule(LABEL_GLOB, { patterns: ['**/*.test.md'] })],
        },
      },
    });
    expect(config.extents?.[EXTENT_NAME]?.closureFrom).toBe(ROOT_DOC);
    expect(config.extents?.[EXTENT_NAME]?.refusals[0]?.label).toBe(LABEL_GLOB);
  });
});

describe('ClosureExtentContributor', () => {
  it('runs in the closure stratum and derives its id from the extent name', () => {
    const contributor = new ClosureExtentContributor(EXTENT_NAME, SKILL_KIND);
    expect(contributor.stratum).toBe('closure');
    expect(contributor.kind).toBe(SKILL_KIND);
    expect(contributor.id).toContain(EXTENT_NAME);
  });

  it('declares one extent whose id carries the root and the extent name', async () => {
    const contribution = await contributeOver(CHAIN, declarationOf());
    const extentId = extentContextId(SKILL_KIND, rootIdFor(ROOT), EXTENT_NAME);
    expect(contribution.contexts).toHaveLength(1);
    expect(contribution.contexts[0]?.contextId).toBe(extentId);
    expect(contribution.memberships.every((row) => row.extentId === extentId)).toBe(true);
    expectContributionRowsValid(contribution);
  });

  it('admits the root and its direct reference at maxDepth 1, and not the file behind it', async () => {
    const contribution = await contributeOver(CHAIN, declarationOf({ maxDepth: 1 }));
    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B]);
  });

  it('admits the whole chain at maxDepth "full"', async () => {
    const contribution = await contributeOver(CHAIN, declarationOf({ maxDepth: 'full' }));
    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B, DOC_C]);
  });

  it('admits only the root at maxDepth 0', async () => {
    const contribution = await contributeOver(CHAIN, declarationOf({ maxDepth: 0 }));
    expect(memberPaths(contribution)).toEqual([ROOT_DOC]);
  });

  it('REPORTS what the hop budget held back, instead of falling silent at the boundary', async () => {
    // The boundary used to be the primitive's one silent verdict: `canDescend`
    // stopped the ENUMERATION at a member sitting on `maxDepth`, so a reference
    // out of it was indistinguishable from a reference nobody authored. The bound
    // now gates ADMISSION only — the split `walk-link-graph.ts` has always had,
    // where `checkExclusions` runs before `processRegistryResource`'s depth check
    // and a link out of a frontier member is still classified and still recorded.
    const contribution = await contributeOver(CHAIN, declarationOf({ maxDepth: 1 }));

    // Membership FIRST, and unchanged: this is a reporting change, and a fixture
    // that let `DOC_C` in would be measuring a different (broken) feature.
    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B]);

    // …and the row, anchored to the TARGET, carrying the referring file's own
    // provenance — the same five facts a refusal carries, because the question
    // "what arrives if I widen maxDepth by one" needs the same answers.
    expect(contribution.conditions).toHaveLength(1);
    expect(contribution.conditions[0]).toMatchObject({
      path: DOC_C,
      code: CLOSURE_DEPTH_EXCEEDED,
      sourcePath: DOC_B,
      sourceLine: 1,
      sourceRef: 'c.md',
      targetExists: true,
      // Null because no RULE decided this — the declaration's bound did. That is
      // how a reader tells a budget verdict from a rule verdict without reading
      // `code`, and it is what the walker's own row says too (`makeExclusion`
      // attaches `matchedRule` only for `pattern-matched`).
      matchedPattern: null,
      matchedPayload: null,
    });
    expectContributionRowsValid(contribution);
  });

  it('emits NO depth row at maxDepth "full", where nothing is ever held back', async () => {
    // The negative control for the case above. Without it, a contributor that
    // emitted `CLOSURE_DEPTH_EXCEEDED` for every followed reference would satisfy
    // every assertion there — and would be reporting a bound that never bit.
    const contribution = await contributeOver(CHAIN, declarationOf({ maxDepth: 'full' }));
    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B, DOC_C]);
    expect(contribution.conditions).toEqual([]);
  });

  it('lets a REFUSAL outrank the hop budget for a reference at the boundary', async () => {
    // Both verdicts apply to `Readme.md`: a rule catches it AND the budget is
    // spent. Only one reason gets reported, and it must be the rule's — the same
    // order `walk-link-graph.ts` checks them in, and the reason the depth check
    // sits last in `hopFor`. A frontier that answered `CLOSURE_DEPTH_EXCEEDED`
    // here would tell an author to widen `maxDepth`, which would not help.
    const files: readonly FixtureFile[] = [
      { path: ROOT_DOC, refs: [{ rawRef: 'b.md' }] },
      { path: DOC_B, refs: [{ rawRef: README_REF }, { rawRef: 'c.md' }] },
      { path: DOC_HUB, refs: [] },
      { path: DOC_C, refs: [] },
    ];
    const contribution = await contributeOver(files, declarationOf({
      maxDepth: 1,
      refusals: [refusalRule(LABEL_BASENAME, { basenames: [README_PATTERN] })],
    }));

    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B]);
    expect(conditionCodeFor(contribution, DOC_HUB)).toBe(LABEL_BASENAME);
    // …and the sibling reference, which only the budget turns away, still gets
    // the other verdict — so the case above is a statement about ORDER and not
    // about a frontier that reports one code for everything.
    expect(conditionCodeFor(contribution, DOC_C)).toBe(CLOSURE_DEPTH_EXCEEDED);
  });

  it('drops a reachable file matched by a refusal rule\'s glob, and says which rule', async () => {
    const files: readonly FixtureFile[] = [
      { path: ROOT_DOC, refs: [{ rawRef: 'b.test.md' }, { rawRef: 'b.md' }] },
      { path: DOC_TEST, refs: [] },
      { path: DOC_B, refs: [] },
    ];
    const withoutExclude = await contributeOver(files, declarationOf());
    expect(memberPaths(withoutExclude)).toContain(DOC_TEST);
    expect(conditionCodeFor(withoutExclude, DOC_TEST)).toBeUndefined();

    const contribution = await contributeOver(files, declarationOf({
      refusals: [refusalRule(LABEL_GLOB, { patterns: ['**/*.test.md'] })],
    }));
    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B]);
    expect(conditionCodeFor(contribution, DOC_TEST)).toBe(LABEL_GLOB);
    expectContributionRowsValid(contribution);
  });

  it('refuses a basename whose only difference from the declaration is CASE', async () => {
    // `Readme.md` against a declared `README.md`. A matcher that compared the two
    // strings directly — or folded only one side — admits the hub and this fails.
    const admitted = await contributeOver(HUB_CHAIN, declarationOf());
    expect(memberPaths(admitted)).toContain(DOC_HUB);

    const contribution = await contributeOver(HUB_CHAIN, declarationOf({
      refusals: [refusalRule(LABEL_BASENAME, { basenames: [README_PATTERN] })],
    }));
    expect(memberPaths(contribution)).not.toContain(DOC_HUB);
    expect(conditionCodeFor(contribution, DOC_HUB)).toBe(LABEL_BASENAME);
  });

  it('PRUNES the subtree behind a refused basename, and records only the HUB', async () => {
    // The 239-path behaviour, at fixture scale: `behind.md` is reachable only
    // through the hub, so refusing the hub must take it too. An assertion that
    // only checked the hub could not tell a refusal that prunes from one that
    // merely skips a member and keeps walking.
    const admitted = await contributeOver(HUB_CHAIN, declarationOf());
    expect(memberPaths(admitted)).toContain(DOC_BEHIND);

    const contribution = await contributeOver(HUB_CHAIN, declarationOf({
      refusals: [refusalRule(LABEL_BASENAME, { basenames: [README_PATTERN] })],
    }));
    // `b.md` survives: the walk was narrowed, not stopped.
    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B]);
    // The pruned file gets NO condition, and that is the honest report: the walk
    // never reached `behind.md`, so no rule ever judged it. A row claiming
    // otherwise would attribute a refusal that never happened — the same
    // distinction the corpus shadow spells `pruned-behind-exclusion`.
    expect(conditionCodeFor(contribution, DOC_HUB)).toBe(LABEL_BASENAME);
    expect(conditionCodeFor(contribution, DOC_BEHIND)).toBeUndefined();
  });

  it('refuses a candidate by resources.kind, which no path glob could express', async () => {
    const admitted = await contributeOver(DIRECTORY_FIXTURE, declarationOf());
    expect(memberPaths(admitted)).toContain(DOC_DIR);

    const contribution = await contributeOver(DIRECTORY_FIXTURE, declarationOf({
      refusals: [refusalRule(LABEL_KIND, { kinds: [DIRECTORY_KIND] })],
    }));
    // The file-kind sibling stays. Without it the assertion would be satisfied by
    // a matcher keyed on the extension-less PATH rather than on the entity kind.
    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B]);
    expect(conditionCodeFor(contribution, DOC_DIR)).toBe(LABEL_KIND);
  });

  it('reports the FIRST matching refusal rule — the ORDER of the cascade IS the behaviour', async () => {
    // `nested` is a DIRECTORY that ALSO matches the glob, so it is caught by both
    // rules and only their order decides which label it reports. Both directions
    // are asserted: a single direction would still pass against an implementation
    // that always picked the kind rule, or always picked the glob one.
    //
    // This is the assertion `walk-link-graph.ts`'s "the order IS the behaviour"
    // note has and the closure primitive used to lack — its old comment claimed
    // the matchers were unordered, which was true only while a refusal carried no
    // payload.
    const kindRule = refusalRule(LABEL_KIND, { kinds: [DIRECTORY_KIND] });
    const globRule = refusalRule(LABEL_GLOB, { patterns: ['skills/foo/nested'] });

    const kindFirst = await contributeOver(
      DIRECTORY_FIXTURE,
      declarationOf({ refusals: [kindRule, globRule] }),
    );
    const globFirst = await contributeOver(
      DIRECTORY_FIXTURE,
      declarationOf({ refusals: [globRule, kindRule] }),
    );

    expect(conditionCodeFor(kindFirst, DOC_DIR)).toBe(LABEL_KIND);
    expect(conditionCodeFor(globFirst, DOC_DIR)).toBe(LABEL_GLOB);

    // …and MEMBERSHIP is identical either way. Without this the test could not
    // distinguish "the order picks the label" from "the order picks the answer",
    // and a refactor that broke membership would be read as an ordering result.
    expect(memberPaths(kindFirst)).toEqual(memberPaths(globFirst));
    expect(memberPaths(kindFirst)).toEqual([ROOT_DOC, DOC_B]);
  });

  it('keeps a label OPAQUE: two rules may share matchers and differ only by name', async () => {
    // The primitive must never interpret a label. Two declarations differing in
    // nothing but the string prove the string is carried rather than recognised.
    const first = await contributeOver(DIRECTORY_FIXTURE, declarationOf({
      refusals: [refusalRule('a-lowercase-label with spaces', { kinds: [DIRECTORY_KIND] })],
    }));
    expect(conditionCodeFor(first, DOC_DIR)).toBe('a-lowercase-label with spaces');
  });

  it('emits ONE refusal row per refused reference, each naming ITS OWN referrer', async () => {
    // Two documents link the same hub, so the refusal is reached twice and both
    // rows are emitted, matching `walkLinkGraph`'s per-reference
    // `excludedReferences`. The rows agree on the VERDICT — same path, same code,
    // same identity, which is `ProjectionBuilder`'s
    // `(extentId, path, code, resourceId)` key — and differ on the PROVENANCE,
    // because they were reached through different references. So a population
    // collapses them to one row and that row names the FIRST referrer; the
    // witness is a witness, not the list.
    const twoReferrers: readonly FixtureFile[] = [
      { path: ROOT_DOC, refs: [{ rawRef: README_REF }, { rawRef: 'b.md' }] },
      { path: DOC_B, refs: [{ rawRef: README_REF }] },
      { path: DOC_HUB, refs: [] },
    ];
    const contribution = await contributeOver(twoReferrers, declarationOf({
      refusals: [refusalRule(LABEL_BASENAME, { basenames: [README_PATTERN] })],
    }));

    const rows = contribution.conditions.filter((row) => row.path === DOC_HUB);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.extentId, row.path, row.code, row.resourceId]))
      .toEqual([rows[0], rows[0]].map((row) => [row?.extentId, row?.path, row?.code, row?.resourceId]));
    expect(rows.map((row) => row.sourcePath)).toEqual([ROOT_DOC, DOC_B]);
    expect(rows[0]?.severity).toBe('info');
    // Anchored to the refused TARGET's identity, not the referrer's — the
    // opposite of an unresolved reference, whose target has no identity at all.
    const hub = contribution.realizations.find((row) => row.path === DOC_HUB);
    expect(hub).toBeUndefined();
    expect(rows[0]?.resourceId).not.toBeNull();
    expectContributionRowsValid(contribution);
  });

  it('admits an admitPaths entry that TWO refusal rules refuse, and records nothing', async () => {
    const refusing = declarationOf({
      refusals: [
        refusalRule(LABEL_GLOB, { patterns: [README_GLOB] }),
        refusalRule(LABEL_BASENAME, { basenames: [README_PATTERN] }),
      ],
    });
    const refused = await contributeOver(HUB_CHAIN, refusing);
    expect(memberPaths(refused)).toEqual([ROOT_DOC, DOC_B]);

    const contribution = await contributeOver(
      HUB_CHAIN,
      { ...refusing, admitPaths: [DOC_HUB] },
    );
    // Admitted AND traversed through: an override that let the file in without
    // restoring its subtree would be a different rule from the one `closureFrom`
    // gets, and `behind.md` is the only witness to the difference.
    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_HUB, DOC_B, DOC_BEHIND]);
    // An admitted path is not a quiet refusal either: `admitPaths` is checked
    // BEFORE the cascade, so no rule ever gets to label it.
    expect(conditionCodeFor(contribution, DOC_HUB)).toBeUndefined();
  });

  it('matches admitPaths by exact path, never by prefix — a glob never named the file', async () => {
    const contribution = await contributeOver(HUB_CHAIN, declarationOf({
      refusals: [refusalRule(LABEL_BASENAME, { basenames: [README_PATTERN] })],
      admitPaths: ['skills/foo'],
    }));
    expect(memberPaths(contribution)).not.toContain(DOC_HUB);
    expect(conditionCodeFor(contribution, DOC_HUB)).toBe(LABEL_BASENAME);
  });

  it('refuses on a BOOLEAN COLUMN of the realization row, and prunes the subtree behind it', async () => {
    // The column matcher's whole reason for existing: `gitignored` is a fact the
    // projection already computed, so refusing on it is a column match and not
    // an oracle the closure would have to consult. `behind.md` is the witness
    // that a column refusal prunes exactly as a basename or kind refusal does.
    const contribution = await contributeOver(FLAG_FIXTURE, declarationOf({
      refusals: [refusalRule(LABEL_FLAG, { flags: { gitignored: true, exists: true } })],
    }));
    // `DOC_C` survives: it is gitignored but does not exist, and the guard is
    // conjunctive — the next case is where that is the thing under test.
    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B, DOC_C]);
    expect(conditionCodeFor(contribution, DOC_HUB)).toBe(LABEL_FLAG);
    expect(memberPaths(contribution)).not.toContain(DOC_BEHIND);
    expectContributionRowsValid(contribution);
  });

  it('reads a MULTI-COLUMN flags record as a CONJUNCTION, not as another OR', async () => {
    // `DOC_C` is gitignored and does NOT exist. Under the disjunctive reading the
    // other three matchers get, it is refused; under the conjunction the walker's
    // existence-gated gitignore branch actually has, it is admitted. The two
    // readings differ on exactly this row, which is what makes the choice
    // falsifiable rather than a stated preference.
    const conjunction = await contributeOver(FLAG_FIXTURE, declarationOf({
      refusals: [refusalRule(LABEL_FLAG, { flags: { gitignored: true, exists: true } })],
    }));
    expect(memberPaths(conjunction)).toContain(DOC_C);
    expect(conditionCodeFor(conjunction, DOC_C)).toBeUndefined();

    // …and dropping the guard DOES refuse it, so the row above is a statement
    // about the conjunction rather than about a fixture the rule never reached.
    const unguarded = await contributeOver(FLAG_FIXTURE, declarationOf({
      refusals: [refusalRule(LABEL_FLAG, { flags: { gitignored: true } })],
    }));
    expect(memberPaths(unguarded)).not.toContain(DOC_C);
    expect(conditionCodeFor(unguarded, DOC_C)).toBe(LABEL_FLAG);
  });

  it('never matches on an EMPTY flags record, which every rule carries by default', async () => {
    // `[].every(...)` is `true`, so without the emptiness guard the schema
    // default would make every rule in every declaration refuse the whole corpus
    // — including the four the skill translation emits.
    const contribution = await contributeOver(FLAG_FIXTURE, declarationOf({
      refusals: [refusalRule(LABEL_FLAG, { flags: {} })],
    }));
    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_HUB, DOC_B, DOC_C, DOC_BEHIND]);
    expect(contribution.conditions).toEqual([]);
  });

  it('THROWS on a flags column no realization row carries, rather than refusing nothing', async () => {
    // A misspelled column is the failure mode an open string key invites: it
    // compiles to a matcher that can never fire, and the declaration then reports
    // a confident zero refusals. The name space is closed precisely so this is an
    // error — the asymmetry with `kinds`, whose vocabulary really is open.
    await expect(contributeOver(FLAG_FIXTURE, declarationOf({
      refusals: [refusalRule(LABEL_FLAG, { flags: { gitIgnored: true } })],
    }))).rejects.toThrow(/gitIgnored/u);
  });

  it('lets an EARLIER rule outrank a flags rule, so the cascade order still decides the label', async () => {
    // The fourth matcher joins the same cascade as the other three: the hub is
    // both a navigation basename and gitignored, and the reported reason is
    // whichever rule sits first — the property `classifyExclusion` has and the
    // reason `refusals` is an array.
    const basenameRule = refusalRule(LABEL_BASENAME, { basenames: [README_PATTERN] });
    const flagRule = refusalRule(LABEL_FLAG, { flags: { gitignored: true, exists: true } });
    const basenameFirst = await contributeOver(FLAG_FIXTURE, declarationOf({
      refusals: [basenameRule, flagRule],
    }));
    const flagFirst = await contributeOver(FLAG_FIXTURE, declarationOf({
      refusals: [flagRule, basenameRule],
    }));
    expect(conditionCodeFor(basenameFirst, DOC_HUB)).toBe(LABEL_BASENAME);
    expect(conditionCodeFor(flagFirst, DOC_HUB)).toBe(LABEL_FLAG);
    expect(memberPaths(basenameFirst)).toEqual(memberPaths(flagFirst));
  });

  it('terminates on a cycle with three members rather than looping', async () => {
    const contribution = await contributeOver(CYCLE, declarationOf({ maxDepth: 'full' }));
    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B, DOC_C]);
  });

  it('says NOTHING about a reference back to its own closureFrom, and still refuses a SIBLING root', async () => {
    // The docstring has always claimed `closureFrom` is admitted the way an
    // `admitPaths` entry is — "an explicit declaration outranks a net". It was
    // true only by accident: the root is seeded into the queue before any rule
    // runs, so nothing ever asked. A reference back to it DID reach `refusalOf`,
    // and a rule naming the root's basename refused the extent's own root — a
    // condition row about a file that is already a member, which every consumer
    // reads as a contradiction.
    //
    // The sibling root is the control. Both references name a `SKILL.md`; only
    // one names THIS extent's root, and the rule must still catch the other —
    // otherwise "no row for the root" would also be satisfied by a declaration
    // whose rule matched nothing at all.
    const contribution = await contributeOver(SELF_LINK, declarationOf({
      refusals: [refusalRule(LABEL_BASENAME, { basenames: [ROOT_BASENAME] })],
    }));

    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B]);
    expect(conditionCodeFor(contribution, ROOT_DOC)).toBeUndefined();
    expect(conditionCodeFor(contribution, DOC_SIBLING_ROOT)).toBe(LABEL_BASENAME);
    expectContributionRowsValid(contribution);
  });

  it('holds no self-link at the hop boundary either — the root is a member, not a candidate', async () => {
    // The second half, and the one only a BOUNDED declaration reaches. With
    // `maxDepth: 1`, `b.md` sits on the frontier, so every reference out of it is
    // resolved and judged (that is the whole of the admission-vs-enumeration
    // split). The reference back to the root would then be reported as
    // `CLOSURE_DEPTH_EXCEEDED` — "widen maxDepth and this arrives" — about the
    // one file the declaration already named.
    //
    // The sibling root is the control again: it IS held back by the budget, so a
    // frontier that fell silent for everything would fail here.
    const contribution = await contributeOver(SELF_LINK, declarationOf({ maxDepth: 1 }));

    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B]);
    expect(conditionCodeFor(contribution, ROOT_DOC)).toBeUndefined();
    expect(conditionCodeFor(contribution, DOC_SIBLING_ROOT)).toBe(CLOSURE_DEPTH_EXCEEDED);
  });

  it('follows only the syntactic forms the declaration names', async () => {
    const files: readonly FixtureFile[] = [
      { path: ROOT_DOC, refs: [{ rawRef: 'b.md', syntacticForm: 'at-prefixed' }] },
      { path: DOC_B, refs: [] },
    ];
    const followingAt = await contributeOver(files, declarationOf({ follow: ['at-prefixed'] }));
    expect(memberPaths(followingAt)).toEqual([ROOT_DOC, DOC_B]);

    const contribution = await contributeOver(files, declarationOf({ follow: [MARKDOWN_LINK] }));
    expect(memberPaths(contribution)).toEqual([ROOT_DOC]);
  });

  it('never follows a reference inside a fenced code block', async () => {
    const files: readonly FixtureFile[] = [
      { path: ROOT_DOC, refs: [{ rawRef: 'b.md', inFence: true }] },
      { path: DOC_B, refs: [] },
    ];
    const contribution = await contributeOver(files, declarationOf());
    expect(memberPaths(contribution)).toEqual([ROOT_DOC]);
  });

  it('records an unresolvable reference as a condition instead of a member', async () => {
    const files: readonly FixtureFile[] = [
      { path: ROOT_DOC, refs: [{ rawRef: 'gone.md' }] },
    ];
    const contribution = await contributeOver(files, declarationOf());
    expect(memberPaths(contribution)).toEqual([ROOT_DOC]);
    expect(contribution.conditions).toHaveLength(1);
    expect(contribution.conditions[0]?.code).toBe(CLOSURE_REFERENCE_UNRESOLVED);
    expect(contribution.conditions[0]?.path).toBe(ROOT_DOC);
    expectContributionRowsValid(contribution);
  });

  it('carries the unresolvable reference\'s own provenance, and observes NO target', async () => {
    // `b.md` RESOLVES and sits first, so the row under test is the SECOND
    // reference — a fixture whose only reference was the broken one could not
    // tell a carried line number from a hardcoded 1.
    const files: readonly FixtureFile[] = [
      { path: ROOT_DOC, refs: [{ rawRef: 'b.md' }, { rawRef: 'gone.md#anchor' }] },
      { path: DOC_B, refs: [] },
    ];
    const conditions = (await contributeOver(files, declarationOf())).conditions;
    expect(conditions).toHaveLength(1);
    const row = conditions[0];
    // `sourcePath` repeats `path` here BECAUSE the row is anchored to the
    // referring file — the target realizes nowhere, so a row naming it would
    // name a file nobody can open. The column means "the referring file" in both
    // anchorings, which is what makes one reading serve both.
    expect(row?.sourcePath).toBe(ROOT_DOC);
    expect(row?.sourceLine).toBe(2);
    // The reference EXACTLY as authored, anchor and all — not the resolved path,
    // which by construction does not exist.
    expect(row?.sourceRef).toBe('gone.md#anchor');
    // Null, never false: no realization holds the path, which is a statement
    // about this projection's population. The contributor did not stat anything,
    // so `false` would be a claim about the disk that nothing here checked.
    expect(row?.targetExists).toBeNull();
    expect(row?.matchedPattern).toBeNull();
    expect(row?.matchedPayload).toBeNull();
  });

  it('separates a reference that LEAVES THE ROOT from one that merely resolves to nothing', async () => {
    // Two references, neither of which any realization holds, and the closure
    // used to report both as `CLOSURE_REFERENCE_UNRESOLVED` — "no realization in
    // this projection" — which is a true statement that hides the one fact the
    // reader needs. `gone.md` is a broken link an author should fix; the other
    // target may exist perfectly well and simply lies outside the corpus the
    // projection was populated from. `walkLinkGraph` has always told them apart
    // (`missing-target` vs `outside-project`), and the closure could too: the
    // root is in hand and containment is path math, not an oracle.
    //
    // Both references sit in ONE fixture so the split is visible as a split. A
    // case that asserted only the escaping reference could not tell a correct
    // discrimination from a rename of every unresolved row.
    const files: readonly FixtureFile[] = [
      { path: ROOT_DOC, refs: [{ rawRef: OUTSIDE_REF }, { rawRef: 'gone.md' }] },
    ];
    const contribution = await contributeOver(files, declarationOf());

    expect(memberPaths(contribution)).toEqual([ROOT_DOC]);
    // The whole condition table, as `path → code` pairs, rather than two lookups.
    // A lookup for a row that is not there returns `undefined`, and so does an
    // unimplemented code constant — so `expect(lookup).toBe(CODE)` passes
    // VACUOUSLY before the split exists. Comparing the table cannot: it names
    // both rows, and the pre-split answer (two `CLOSURE_REFERENCE_UNRESOLVED`
    // rows anchored on the referrer) is a different table.
    expect(contribution.conditions.map((row) => `${row.path} -> ${row.code}`)).toEqual([
      `${OUTSIDE_PATH} -> ${CLOSURE_REFERENCE_OUTSIDE_ROOT}`,
      `${ROOT_DOC} -> ${CLOSURE_REFERENCE_UNRESOLVED}`,
    ]);
    expectContributionRowsValid(contribution);
  });

  it('anchors the outside-root row on the TARGET, and observes nothing about it', async () => {
    // Anchored to the target, unlike `CLOSURE_REFERENCE_UNRESOLVED` and for that
    // row's own reason read the other way round: an escaping reference names a
    // real place on disk that this population simply does not cover, so the row
    // CAN name the file the decision was about — which is also the file
    // `walkLinkGraph`'s `outside-project` row names.
    const files: readonly FixtureFile[] = [
      { path: ROOT_DOC, refs: [{ rawRef: 'b.md' }, { rawRef: `${OUTSIDE_REF}#anchor` }] },
      { path: DOC_B, refs: [] },
    ];
    const row = (await contributeOver(files, declarationOf())).conditions[0];

    expect(row?.path).toBe(OUTSIDE_PATH);
    expect(row?.sourcePath).toBe(ROOT_DOC);
    expect(row?.sourceLine).toBe(2);
    expect(row?.sourceRef).toBe(`${OUTSIDE_REF}#anchor`);
    // Null, never false. Nothing outside the root is realized here, and this
    // contributor stats nothing — so the projection has no answer, which is
    // exactly what the column's null means. It is also why an outside-root row is
    // NOT compared against the walker's `targetExists`: the walker DID stat it.
    expect(row?.targetExists).toBeNull();
    // No identity either: the population never minted one for a path it does not
    // cover, and inventing one here would let a link outside the corpus create a
    // resource.
    expect(row?.resourceId).toBeNull();
    expect(row?.matchedPattern).toBeNull();
    expect(row?.matchedPayload).toBeNull();
  });

  it('carries a refusal\'s provenance: which reference, at which line, by which rule', async () => {
    // The five facts `walk-link-graph.ts`'s `LinkResolution` carries beside its
    // reason, which is what a consumer needs to raise the issue the walker
    // raises rather than only knowing that something was turned away.
    const contribution = await contributeOver(HUB_CHAIN, declarationOf({
      refusals: [{
        label: LABEL_GLOB,
        patterns: [README_GLOB, 'never/**'],
        payload: { ruleIndex: 7, template: 'see {{path}}' },
      }],
    }));
    const row = contribution.conditions.find((entry) => entry.path === DOC_HUB);
    // Anchored to the refused TARGET, and pointing back at the REFERRING file:
    // the two are different files here, which a fixture whose referrer and
    // target coincided could not show.
    expect(row?.path).toBe(DOC_HUB);
    expect(row?.sourcePath).toBe(ROOT_DOC);
    expect(row?.sourceLine).toBe(1);
    expect(row?.sourceRef).toBe(README_REF);
    // A COLUMN of the realization row, not a probe — which is what keeps the
    // module's "no filesystem I/O of its own" claim true.
    expect(row?.targetExists).toBe(true);
    // The matched rule's FIRST declared glob, read the way
    // `packaging-validator.ts` reads `matchedRule.patterns[0]`: it names WHICH
    // rule, not which of its globs fired.
    expect(row?.matchedPattern).toBe(README_GLOB);
    // Verbatim and uninterpreted — the primitive treats a payload exactly as it
    // treats a label.
    expect(row?.matchedPayload).toEqual({ ruleIndex: 7, template: 'see {{path}}' });
    expectContributionRowsValid(contribution);
  });

  it('reports NO matchedPattern for a rule that refused by basename', async () => {
    // The column names the rule through its identifying glob, so a rule that
    // declares none has nothing to name. Null rather than an empty string: a
    // consumer must be able to tell "this rule is not a pattern rule" from "its
    // first pattern is empty", which no min(1) string could say.
    const contribution = await contributeOver(HUB_CHAIN, declarationOf({
      refusals: [refusalRule(LABEL_BASENAME, { basenames: [README_PATTERN] })],
    }));
    const row = contribution.conditions.find((entry) => entry.path === DOC_HUB);
    expect(row?.code).toBe(LABEL_BASENAME);
    expect(row?.matchedPattern).toBeNull();
    expect(row?.matchedPayload).toBeNull();
    // …but the reference provenance is unaffected: it comes from the walk, not
    // from the matcher.
    expect(row?.sourcePath).toBe(ROOT_DOC);
    expect(row?.sourceRef).toBe(README_REF);
  });

  it('reports an absent closureFrom as an error condition, not an unexplained empty extent', async () => {
    const contribution = await contributeOver([{ path: DOC_B, refs: [] }], declarationOf());
    expect(memberPaths(contribution)).toEqual([]);
    expect(contribution.conditions[0]?.code).toBe(CLOSURE_ROOT_ABSENT);
    expect(contribution.conditions[0]?.severity).toBe('error');
    // No reference provoked it — the root arrives from the DECLARATION — so
    // every provenance column is null rather than pointing at a link nobody
    // wrote.
    expect(contribution.conditions[0]).toMatchObject(CONDITION_WITHOUT_REFERENCE);
  });

  it('refuses a declaration whose kind disagrees with the registered kind', async () => {
    await expect(contributeOver(CHAIN, { kind: 'plugin', closureFrom: ROOT_DOC })).rejects.toThrow(/kind/u);
  });

  it('is a pure function of the base: two runs over one base contribute identically', async () => {
    const base = buildBase(CHAIN);
    const contributor = new ClosureExtentContributor(EXTENT_NAME, SKILL_KIND);
    const first = await contributor.contribute(base, declarationOf());
    const second = await contributor.contribute(base, declarationOf());
    expect(memberPaths(second)).toEqual(memberPaths(first));
  });
});
