import { createHash } from 'node:crypto';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { ExtentContribution } from '../src/projection/contributor.js';
import {
  CLOSURE_REFERENCE_UNRESOLVED,
  CLOSURE_ROOT_ABSENT,
  ClosureExtentContributor,
} from '../src/projection/contributors/closure-extent.js';
import { extentContextId } from '../src/projection/contributors/context-id.js';
import { rootIdFor } from '../src/projection/identity.js';
import { ProjectionBuilder, type ProjectionBase } from '../src/projection/projection.js';
import { ExtentDeclarationSchema, ProjectConfigSchema } from '../src/schemas/project-config.js';
import type { BlobReferenceRow, ReferenceSyntacticForm } from '../src/schemas/projection-blobs.js';
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
  { path: ROOT_DOC, refs: [{ rawRef: 'Readme.md' }, { rawRef: 'b.md' }] },
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
  { path: ROOT_DOC, refs: [{ rawRef: 'Readme.md' }, { rawRef: 'b.md' }, { rawRef: 'c.md' }] },
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
      label: LABEL_KIND, patterns: [], basenames: [], kinds: [DIRECTORY_KIND], flags: {},
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

  it('emits ONE refusal row per refused reference, carrying the target\'s identity', async () => {
    // Two documents link the same hub, so the refusal is reached twice. Both rows
    // are emitted (matching `walkLinkGraph`'s per-reference `excludedReferences`)
    // and they are IDENTICAL, which is what lets `ProjectionBuilder`'s
    // `(extentId, path, code, resourceId)` key collapse them to one in a real
    // population without losing anything.
    const twoReferrers: readonly FixtureFile[] = [
      { path: ROOT_DOC, refs: [{ rawRef: 'Readme.md' }, { rawRef: 'b.md' }] },
      { path: DOC_B, refs: [{ rawRef: 'Readme.md' }] },
      { path: DOC_HUB, refs: [] },
    ];
    const contribution = await contributeOver(twoReferrers, declarationOf({
      refusals: [refusalRule(LABEL_BASENAME, { basenames: [README_PATTERN] })],
    }));

    const rows = contribution.conditions.filter((row) => row.path === DOC_HUB);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual(rows[0]);
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
        refusalRule(LABEL_GLOB, { patterns: ['skills/**/Readme.md'] }),
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

  it('reports an absent closureFrom as an error condition, not an unexplained empty extent', async () => {
    const contribution = await contributeOver([{ path: DOC_B, refs: [] }], declarationOf());
    expect(memberPaths(contribution)).toEqual([]);
    expect(contribution.conditions[0]?.code).toBe(CLOSURE_ROOT_ABSENT);
    expect(contribution.conditions[0]?.severity).toBe('error');
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
