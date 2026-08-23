import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import type { ExtentContribution } from '../src/projection/contributor.js';
import {
  CLAUDE_IMPORT_KIND,
  ClaudeImportExtentContributor,
  claudeImportContributorId,
  claudeImportExtentDeclaration,
  claudeImportRootsFrom,
} from '../src/projection/contributors/claude-import-extent.js';
import {
  CLOSURE_DEPTH_EXCEEDED,
  CLOSURE_REFERENCE_OUTSIDE_ROOT,
  CLOSURE_REFERENCE_UNRESOLVED,
} from '../src/projection/contributors/closure-extent.js';
import { ProjectionBuilder, type ProjectionBase } from '../src/projection/projection.js';
import type { JsonValue } from '../src/schemas/projection-shared.js';

import { addFile } from './helpers/claude-context-fixture.js';
import { projectionRealizationRow } from './test-helpers.js';

/**
 * A root that is never touched on disk.
 *
 * Deliberately not under `/tmp` (`sonarjs/publicly-writable-directories`), and
 * deliberately never created: this contributor reads the base projection and
 * resolves paths lexically, so a fixture needing files on disk would be testing
 * the wrong thing.
 */
const ROOT = '/vat-corpus/claude-import-fixture';

/** The extent the hand-built base realizes its files in. */
const BASE_EXTENT = 'ctx-filesystem-fixture';

/** The corpus root's own `CLAUDE.md` — the root most fixtures below close over. */
const ROOT_CLAUDE_MD = 'CLAUDE.md';

/** A nested `CLAUDE.md`, for the cases that must not read a root-relative path. */
const DOCS_CLAUDE_MD = 'docs/CLAUDE.md';

/** The file `docs/CLAUDE.md` imports in this repo, for real — `@README.md`. */
const DOCS_README = 'docs/README.md';

/** A rules file in the PROJECT-ROOT `.claude/rules/`, the root-scoped location. */
const ROOT_RULES_FILE = '.claude/rules/style.md';

/** One of a byte-identical importer pair — see the shared-blob case below. */
const A_CLAUDE_MD = 'a/CLAUDE.md';

/** Its twin, in a sibling directory. */
const B_CLAUDE_MD = 'b/CLAUDE.md';

/**
 * One fixture file: a path, and the markdown whose REAL parse supplies its
 * references.
 *
 * 🪤 There is deliberately no hand-built-row escape hatch here. The defect this
 * whole module exists to fix was invisible for exactly as long as the only test
 * of `@`-following planted a row the shipped lexer could never emit, so every
 * fixture in this file goes through `parseMarkdownContent` and
 * `blobReferencesFor` — the producers that run in production.
 */
interface FixtureFile {
  path: string;
  markdown: string;
  /** `'directory'` builds a keyless directory realization instead of a file. */
  kind?: string;
}

/**
 * Add one keyless directory realization.
 *
 * The one shape {@link addFile} genuinely cannot express: its realization is
 * always a FILE (`isDirectory: false`, a content key, a blob), and the shared
 * fixture's own directory writer is private to it. A directory row is built
 * here rather than routed through a content key it must not have — a directory
 * has no bytes, so `contentState: 'none'` is the truth and any key at all would
 * be a fiction.
 *
 * @param builder - The builder under construction
 * @param path - Root-relative, forward-slashed directory path
 */
function addDirectory(builder: ProjectionBuilder, path: string): void {
  const resourceId = builder.identities.idFor(safePath.join(ROOT, path));
  builder.addResource({
    resourceId,
    kind: 'directory',
    origin: 'filesystem',
    observed: true,
    fromEnumeration: true,
    vatId: null,
  });
  builder.addRealization({
    ...projectionRealizationRow({
      resourceId,
      extentId: BASE_EXTENT,
      path,
      contentKey: null,
      isDirectory: true,
    }),
    contentState: 'none',
  });
}

/**
 * A base projection holding exactly these files, with references from the REAL
 * parser and content keys derived from the REAL bytes.
 *
 * 🪤 Keys used to be `markdown.sha256(<path>)`, and that was not a harmless
 * shortcut. `content-key.ts` is explicit that a key is a function of bytes and
 * parser kind alone, so `blob_references` is a per-CONTENT table and two
 * byte-identical documents in different directories share ONE blob and ONE set
 * of reference rows. Path-keying made this fixture's keys one-to-one with paths
 * — a shape production never has — so any consumer that mapped a key back to
 * "the path that wrote this" looked correct here and collapsed against a real
 * tree. {@link addFile} keys by content, exactly as production does.
 */
function buildBase(files: readonly FixtureFile[]): ProjectionBase {
  const builder = new ProjectionBuilder(ROOT);
  for (const file of files) {
    if (file.kind === 'directory') {
      addDirectory(builder, file.path);
      continue;
    }
    addFile(builder, { path: file.path, refs: [], markdown: file.markdown }, ROOT);
  }
  return builder.base();
}

/** Run the contributor over a fixture set, rooted at one declared path. */
async function contributeFrom(
  files: readonly FixtureFile[],
  rootRelativePath: string,
): Promise<ExtentContribution> {
  const contributor = new ClaudeImportExtentContributor(rootRelativePath);
  return contributor.contribute(
    buildBase(files),
    claudeImportExtentDeclaration(rootRelativePath) as unknown as JsonValue,
  );
}

/** The member paths of a contribution, in the order the walk admitted them. */
function memberPaths(contribution: ExtentContribution): string[] {
  return contribution.realizations.map((row) => row.path);
}

/** The condition codes a contribution carries, in row order. */
function conditionCodes(contribution: ExtentContribution): string[] {
  return contribution.conditions.map((row) => row.code);
}

describe('claudeImportExtentDeclaration', () => {
  it('follows ONLY at-prefixed tokens, under the claude-import dialect, to four hops', () => {
    // Every field is load-bearing and every one is asserted, because each is a
    // place a default would be silently wrong: the schema's `follow` default is
    // the three markdown forms (which the harness does not load), its
    // `referenceDialect` default is `href` (under which no import resolves at
    // all), and its `maxDepth` default is `'full'` (which the vendor bounds).
    expect(claudeImportExtentDeclaration(DOCS_CLAUDE_MD)).toEqual({
      kind: CLAUDE_IMPORT_KIND,
      closureFrom: DOCS_CLAUDE_MD,
      follow: ['at-prefixed'],
      referenceDialect: 'claude-import',
      maxDepth: 4,
      refusals: [],
      admitPaths: [],
    });
  });

  it('refuses a root with no path — a closure with no root closes over nothing', () => {
    expect(() => claudeImportExtentDeclaration('')).toThrow();
  });
});

describe('claudeImportContributorId', () => {
  it('discriminates on the root-relative path, which is unique by construction', () => {
    // `ContributorRegistry.register` throws on a duplicate id, so a collision is
    // a FAILED population rather than a mild defect. A frontmatter `name` would
    // not do: it is caller-supplied text that may be missing or repeated.
    expect(claudeImportContributorId(DOCS_CLAUDE_MD))
      .not.toBe(claudeImportContributorId(ROOT_CLAUDE_MD));
  });
});

describe('claudeImportRootsFrom', () => {
  it('selects CLAUDE.md, CLAUDE.local.md and .claude/rules files, and nothing else', () => {
    const base = buildBase([
      { path: ROOT_CLAUDE_MD, markdown: '' },
      { path: 'docs/CLAUDE.local.md', markdown: '' },
      { path: ROOT_RULES_FILE, markdown: '' },
      { path: 'packages/cli/.claude/rules/nested.md', markdown: '' },
      { path: DOCS_README, markdown: '' },
      { path: 'packages/cli/src/index.ts', markdown: '' },
    ]);

    expect(claudeImportRootsFrom(base.resourceRealizations)).toEqual([
      ROOT_RULES_FILE,
      'CLAUDE.md',
      'docs/CLAUDE.local.md',
      'packages/cli/.claude/rules/nested.md',
    ]);
  });

  it('never selects a directory, however its path is spelled', () => {
    // A directory has no blob, so an extent rooted at one would declare a root
    // the base realizes and the blob stage cannot key — and the closure would
    // report a complete extent of exactly one member, forever, in silence.
    const base = buildBase([{ path: 'weird/CLAUDE.md', markdown: '', kind: 'directory' }]);
    expect(claudeImportRootsFrom(base.resourceRealizations)).toEqual([]);
  });

  it('returns a SORTED list, so registration order is a property of the tree', () => {
    // Not cosmetic: contributor ids are registered in this order, and a
    // population whose contributor set depends on enumeration order is not
    // reproducible.
    const base = buildBase([
      { path: 'z/CLAUDE.md', markdown: '' },
      { path: A_CLAUDE_MD, markdown: '' },
      { path: 'm/CLAUDE.md', markdown: '' },
    ]);
    expect(claudeImportRootsFrom(base.resourceRealizations))
      .toEqual([A_CLAUDE_MD, 'm/CLAUDE.md', 'z/CLAUDE.md']);
  });
});

describe('ClaudeImportExtentContributor', () => {
  it('admits a real @-import as a member', async () => {
    // Deliberately the shape this repo actually contains: `docs/CLAUDE.md`
    // holding `@README.md`. Before the dialect this resolved `docs/@README.md`,
    // and both of the repo's import edges vanished as `info` rows
    // indistinguishable from ordinary broken links.
    const contribution = await contributeFrom(
      [
        { path: DOCS_CLAUDE_MD, markdown: '# Docs\n\n@README.md\n' },
        { path: DOCS_README, markdown: '# Readme\n' },
      ],
      DOCS_CLAUDE_MD,
    );

    expect(memberPaths(contribution)).toEqual([DOCS_CLAUDE_MD, DOCS_README]);
    expect(conditionCodes(contribution)).toEqual([]);
  });

  it('admits four hops and refuses the fifth', async () => {
    // Pins the vendor's documented bound from BOTH sides. `canDescend` is
    // `depth < maxDepth` with the root seeded at 0, so hop 4 is the last
    // admitted — and a fixture asserting only the admitted side could not tell
    // an off-by-one from a correct bound.
    const chain: readonly FixtureFile[] = [
      { path: ROOT_CLAUDE_MD, markdown: '@a.md\n' },
      { path: 'a.md', markdown: '@b.md\n' },
      { path: 'b.md', markdown: '@c.md\n' },
      { path: 'c.md', markdown: '@d.md\n' },
      { path: 'd.md', markdown: '@e.md\n' },
      { path: 'e.md', markdown: '# too far\n' },
    ];

    const contribution = await contributeFrom(chain, ROOT_CLAUDE_MD);

    expect(memberPaths(contribution))
      .toEqual([ROOT_CLAUDE_MD, 'a.md', 'b.md', 'c.md', 'd.md']);
    expect(conditionCodes(contribution)).toEqual([CLOSURE_DEPTH_EXCEEDED]);
  });

  it('ignores an @ inside a fence and inside a code span', async () => {
    // Vendor-documented: import parsing skips code spans and fenced blocks. The
    // `@real.md` control is what keeps this from also being satisfied by a walk
    // that followed nothing.
    const contribution = await contributeFrom(
      [
        {
          path: ROOT_CLAUDE_MD,
          markdown: 'Literal `@spanned.md` here.\n\n```\n@fenced.md\n```\n\n@real.md\n',
        },
        { path: 'spanned.md', markdown: '' },
        { path: 'fenced.md', markdown: '' },
        { path: 'real.md', markdown: '' },
      ],
      ROOT_CLAUDE_MD,
    );

    expect(memberPaths(contribution)).toEqual([ROOT_CLAUDE_MD, 'real.md']);
  });

  it('names an escaping @~/ import OUTSIDE_ROOT and never as a member', async () => {
    // The vendor's own recommended cross-worktree spelling, and a HEALTHY state:
    // it must be NAMED and not CHARGED, and it must not read as a broken link.
    // Whether it actually loaded is not knowable from the tree at all — the
    // first external import triggers an approval dialog that may have been
    // declined.
    const contribution = await contributeFrom(
      [{ path: ROOT_CLAUDE_MD, markdown: '@~/.claude/my-project-instructions.md\n' }],
      ROOT_CLAUDE_MD,
    );

    expect(memberPaths(contribution)).toEqual([ROOT_CLAUDE_MD]);
    expect(conditionCodes(contribution)).toEqual([CLOSURE_REFERENCE_OUTSIDE_ROOT]);
  });

  it('reports a dangling in-root import and a bare @handle as separate UNRESOLVED rows', async () => {
    // Both are `info` in the PROJECTION. Grading them apart — a path-shaped
    // token warns, `@jeff` in prose stays quiet — is a RENDER decision and
    // belongs to the command, not to a primitive the skill lane also uses. What
    // the projection owes is that both rows exist and carry the token the
    // grader will read.
    const contribution = await contributeFrom(
      [{ path: ROOT_CLAUDE_MD, markdown: '@docs/missing.md\n\nThanks @jeff for the note.\n' }],
      ROOT_CLAUDE_MD,
    );

    expect(memberPaths(contribution)).toEqual([ROOT_CLAUDE_MD]);
    expect(conditionCodes(contribution))
      .toEqual([CLOSURE_REFERENCE_UNRESOLVED, CLOSURE_REFERENCE_UNRESOLVED]);
    expect(contribution.conditions.map((row) => row.sourceRef))
      .toEqual(['@docs/missing.md', '@jeff']);
  });

  it('admits a diamond import exactly once', async () => {
    // Two importers, one target. The extent is a SET of members; a second
    // membership row for one identity is what would make a later token sum
    // double-count.
    const contribution = await contributeFrom(
      [
        { path: ROOT_CLAUDE_MD, markdown: '@a.md\n@b.md\n' },
        { path: 'a.md', markdown: '@shared.md\n' },
        { path: 'b.md', markdown: '@shared.md\n' },
        { path: 'shared.md', markdown: '# shared\n' },
      ],
      ROOT_CLAUDE_MD,
    );

    expect(memberPaths(contribution)).toEqual([ROOT_CLAUDE_MD, 'a.md', 'b.md', 'shared.md']);
    expect(contribution.memberships).toHaveLength(4);
  });

  it('is rooted at a rules file just as readily as at a CLAUDE.md', async () => {
    // §3.3: imports in PROJECT-scope `.claude/rules` are genuinely undocumented,
    // and following them anyway is the deliberate choice — under-following is
    // the silent under-report direction. If project rules turn out not to
    // support imports we have recorded a few extra edges; the other way round
    // the budget is quietly wrong.
    const contribution = await contributeFrom(
      [
        { path: ROOT_RULES_FILE, markdown: '---\npaths: ["**/*.ts"]\n---\n\n@guide.md\n' },
        { path: '.claude/rules/guide.md', markdown: '# guide\n' },
      ],
      ROOT_RULES_FILE,
    );

    expect(memberPaths(contribution))
      .toEqual([ROOT_RULES_FILE, '.claude/rules/guide.md']);
  });
});

describe('ClaudeImportExtentContributor — remaining §10 cases', () => {
  it('imports resolve relative to the IMPORTING file, not to the corpus root', async () => {
    // Vendor-documented, and the case a root-relative reading would get wrong at
    // every depth below 1. `docs/handbook.md` importing `@sub/deep.md` must
    // reach `docs/sub/deep.md`. The decoy at `sub/deep.md` is what makes the two
    // readings distinguishable — without it, both resolve to something.
    const contribution = await contributeFrom(
      [
        { path: ROOT_CLAUDE_MD, markdown: '@docs/handbook.md\n' },
        { path: 'docs/handbook.md', markdown: '@sub/deep.md\n' },
        { path: 'docs/sub/deep.md', markdown: '# deep\n' },
        { path: 'sub/deep.md', markdown: '# the WRONG one\n' },
      ],
      ROOT_CLAUDE_MD,
    );

    expect(memberPaths(contribution))
      .toEqual([ROOT_CLAUDE_MD, 'docs/handbook.md', 'docs/sub/deep.md']);
  });

  it('never follows a markdown link, however inviting', async () => {
    // `follow: ['at-prefixed']` is the load-bearing line. The schema DEFAULT is
    // the three markdown forms, and taking it here would drag the entire linked
    // docs tree into a budget the harness never charges.
    const contribution = await contributeFrom(
      [
        { path: ROOT_CLAUDE_MD, markdown: 'See [the guide](guide.md) and @real.md.\n' },
        { path: 'guide.md', markdown: '# guide\n' },
        { path: 'real.md', markdown: '# real\n' },
      ],
      ROOT_CLAUDE_MD,
    );

    expect(memberPaths(contribution)).toEqual([ROOT_CLAUDE_MD, 'real.md']);
  });

  it('does not follow @${VAR}/path.md, because the lexer calls it env-anchored', async () => {
    // 🪤 Pinned as a BOUND, not as a wish. `reference-lexer.ts`'s `classify`
    // gives a token carrying a variable expansion `env-anchored` whatever else
    // it looks like, so `follow: ['at-prefixed']` never selects it. Asserting it
    // here is what stops the day it changes from being a silent behaviour shift.
    const contribution = await contributeFrom(
      [
        { path: ROOT_CLAUDE_MD, markdown: '@${HOME}/notes.md\n' },
        { path: 'notes.md', markdown: '# notes\n' },
      ],
      ROOT_CLAUDE_MD,
    );

    expect(memberPaths(contribution)).toEqual([ROOT_CLAUDE_MD]);
    expect(conditionCodes(contribution)).toEqual([]);
  });

  it('resolves ONE shared blob against each importer, not against an owning path', async () => {
    // 🪤 The shape the old path-keyed fixture could not build. `a/CLAUDE.md` and
    // `b/CLAUDE.md` are byte-identical, so they share a single content key and a
    // single `blob_references` row — one edge, two importers. The walk goes
    // path → realization → contentKey → references and resolves each `rawRef`
    // against the REFERRING PATH, so the same edge must reach `a/notes.md` from
    // one and `b/notes.md` from the other. A consumer that instead asked the key
    // "which path wrote you?" gets a many-to-one map, last write wins, and one
    // of these two closures silently imports the other directory's file — which
    // is the defect that shipped green in the discovery lens for exactly as long
    // as every fixture gave each path a private blob.
    const shared = '@notes.md\n';
    const files: readonly FixtureFile[] = [
      { path: A_CLAUDE_MD, markdown: shared },
      { path: B_CLAUDE_MD, markdown: shared },
      { path: 'a/notes.md', markdown: '# notes for a\n' },
      { path: 'b/notes.md', markdown: '# notes for b\n' },
    ];

    // The pin that makes the two assertions below mean something: without it a
    // fixture that quietly went back to one-blob-per-path would still pass them.
    const base = buildBase(files);
    const importerKeys = base.resourceRealizations
      .filter((row) => row.path === A_CLAUDE_MD || row.path === B_CLAUDE_MD)
      .map((row) => row.contentKey);
    expect(importerKeys).toHaveLength(2);
    expect(new Set(importerKeys).size).toBe(1);
    expect(base.blobReferences.filter((row) => row.blob === importerKeys[0])).toHaveLength(1);

    expect(memberPaths(await contributeFrom(files, A_CLAUDE_MD)))
      .toEqual([A_CLAUDE_MD, 'a/notes.md']);
    expect(memberPaths(await contributeFrom(files, B_CLAUDE_MD)))
      .toEqual([B_CLAUDE_MD, 'b/notes.md']);
  });

  it('resolves a cycle without hanging and admits each member once', async () => {
    // The visited set and the depth cap are independent guards, and a cycle is
    // what the first one is for: at `maxDepth: 4` this chain has depth to spare,
    // so only the visited set can stop it.
    const contribution = await contributeFrom(
      [
        { path: ROOT_CLAUDE_MD, markdown: '@a.md\n' },
        { path: 'a.md', markdown: '@b.md\n' },
        { path: 'b.md', markdown: '@a.md\n' },
      ],
      ROOT_CLAUDE_MD,
    );

    expect(memberPaths(contribution)).toEqual([ROOT_CLAUDE_MD, 'a.md', 'b.md']);
    expect(contribution.memberships).toHaveLength(3);
  });
});
