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
    kind: 'file',
    origin: 'filesystem',
    observed: true,
    fromEnumeration: true,
    vatId: null,
  });
  builder.addRealization(realizationRow(resourceId, file.path, contentKey));
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
    expect(parsed.exclude).toEqual([]);
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
          exclude: ['**/*.test.md'],
        },
      },
    });
    expect(config.extents?.[EXTENT_NAME]?.closureFrom).toBe(ROOT_DOC);
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

  it('drops a reachable file matched by an exclude glob', async () => {
    const files: readonly FixtureFile[] = [
      { path: ROOT_DOC, refs: [{ rawRef: 'b.test.md' }, { rawRef: 'b.md' }] },
      { path: DOC_TEST, refs: [] },
      { path: DOC_B, refs: [] },
    ];
    const withoutExclude = await contributeOver(files, declarationOf());
    expect(memberPaths(withoutExclude)).toContain(DOC_TEST);

    const contribution = await contributeOver(files, declarationOf({ exclude: ['**/*.test.md'] }));
    expect(memberPaths(contribution)).toEqual([ROOT_DOC, DOC_B]);
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
