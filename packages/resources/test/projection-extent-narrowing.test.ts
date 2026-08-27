/**
 * The deciding fixture for the filesystem extent's **narrowing** claim.
 *
 * `filesystem-extent.ts` ends its header with "this extent cannot be narrowed —
 * dropping non-markdown loses real members". That was reasoned and never
 * measured, and it is the sentence cited to justify keying non-markdown files,
 * so it is worth a corpus rather than an argument.
 *
 * ## The corpus, and why this shape
 *
 * `SKILL.md` → `scripts/tool.mjs` → `docs/note.md`: the leaf is written so it is
 * named ONLY by the non-markdown hop. That makes "the script is a door" and "the
 * script is a dead end" distinguishable outcomes rather than one silent one — a
 * corpus whose leaf were also linked from `SKILL.md` could not tell them apart.
 *
 * The script names the leaf twice, the two ways a real script names a path: once
 * in a JSDoc comment, once as a bare `readFileSync('docs/note.md')` token.
 *
 * ## ⚠️ What this suite USED to prove, and why that proof is gone
 *
 * Until parse routing became MIME-driven, every non-`.html` file was handed to
 * the remark markdown parser, so the JSDoc reference in the `.mjs` lexed as an
 * AST `markdown-link` — a form the default `follow` set traverses. The leaf was
 * therefore a TRANSITIVE member, and an arm of this suite pinned that as the
 * precondition of the verdict: *"follows the script hop because a JSDoc comment
 * IS markdown"*.
 *
 * A `.mjs` now routes to no document parser (`content-key.ts`'s third
 * `ParserKind`, the one naming the *absence* of a parser). It still gets a blob,
 * a token estimate, `measureContent` and `findLexicalReferences` over its raw
 * source — but no AST, so it emits no `markdown-link`, `markdown-link-reference`
 * or `markdown-definition` row at all. Both of its references now lex as
 * `bare-token`, which {@link ExtentDeclarationSchema}'s default `follow` does not
 * traverse. **That arm's subject no longer exists and it has been deleted rather
 * than kept alive on a contrived population** (renaming the script `.md` would
 * re-create the old condition and prove nothing about the corpus VAT actually
 * meets). Widening the default `follow` to `bare-token` was considered and
 * declined: `bare-token` is 21,687 rows on this repo alone, so every `import`
 * specifier and path-shaped string would become a closure edge.
 *
 * ## The re-derived verdict
 *
 * **Bundled scripts are still closure MEMBERS; they are no longer closure
 * DOORS.** Narrowing the extent to markdown still loses a real member — the
 * script is a direct link target of its own root — so the header's claim
 * survives, but on the direct half only. `docs/note.md` is on disk, is
 * enumerated by the filesystem extent, and is a member of nothing.
 *
 * ## Narrowing is SIMULATED, never performed
 *
 * The extent still enumerates everything; the non-markdown row is withheld from
 * the closure by a `refusals` rule instead. A refused candidate "is neither
 * admitted nor traversed through" (`closure-extent.ts`), which is the same
 * membership consequence a narrowed base would have — without this suite
 * changing the behaviour it exists to measure.
 *
 * ## What could not be asked here
 *
 * Neither arm can run under `CONTENT_PARSING_SKIP`: a registered closure
 * contributor makes that request throw outright, so a skipping lane cannot pose
 * a membership question at all. That refusal is pinned in
 * `projection-blob-derivation.test.ts` and is not re-asserted here.
 */

import { compareCodeUnits } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ContributorRegistry } from '../src/projection/contributor.js';
import { ClosureExtentContributor } from '../src/projection/contributors/closure-extent.js';
import { FilesystemExtentContributor } from '../src/projection/contributors/filesystem-extent.js';
import { DISCARD_BLOB_POPULATION, populate } from '../src/projection/merge.js';
import type { Projection } from '../src/projection/projection.js';
import { ExtentDeclarationSchema } from '../src/schemas/project-config.js';
import type { JsonValue } from '../src/schemas/projection-shared.js';

import { setupSubdirTestSuite, writeFileIn } from './test-helpers.js';

const suite = setupSubdirTestSuite('extent-narrowing-');

const EXTENT_NAME = 'narrowing';
const SKILL_KIND = 'skill';
const ROOT_DOC = 'SKILL.md';
const SCRIPT = 'scripts/tool.mjs';
const LEAF_DOC = 'docs/note.md';

/** Every file the corpus writes — the population every membership claim is measured against. */
const CORPUS_FILES = [ROOT_DOC, SCRIPT, LEAF_DOC].sort(compareCodeUnits);

/** The rule that stands in for "the extent enumerated no non-markdown file". */
const NARROWED = 'non-markdown-withheld';

/** The default `follow` set, read from the schema rather than restated. */
const DEFAULT_FOLLOW = ExtentDeclarationSchema.parse({
  kind: SKILL_KIND,
  closureFrom: ROOT_DOC,
}).follow;

beforeAll(suite.beforeAll);
afterAll(suite.afterAll);
beforeEach(async () => {
  await suite.beforeEach();
  writeFileIn(suite.tempDir, ROOT_DOC, `# Skill\n\nRuns [the tool](${SCRIPT}).\n`);
  writeFileIn(
    suite.tempDir,
    SCRIPT,
    `/** Reads the [note](../${LEAF_DOC}). */\nimport { readFileSync } from 'node:fs';\n\n`
    + `export const note = (): Buffer => readFileSync('${LEAF_DOC}');\n`,
  );
  writeFileIn(suite.tempDir, LEAF_DOC, '# Note\n\nLeaf.\n');
});

/**
 * Populate the corpus, optionally withholding the non-markdown row.
 *
 * @param narrowed - True to refuse `**\/*.mjs`, standing in for a narrowed extent
 * @returns The projection
 */
async function populateCorpus(narrowed: boolean): Promise<Projection> {
  const registry = new ContributorRegistry();
  registry.register(new FilesystemExtentContributor());
  registry.register(new ClosureExtentContributor(EXTENT_NAME, SKILL_KIND));

  const declaration = {
    kind: SKILL_KIND,
    closureFrom: ROOT_DOC,
    ...(narrowed ? { refusals: [{ label: NARROWED, patterns: ['**/*.mjs'] }] } : {}),
  };
  return populate({
    root: suite.tempDir,
    registry,
    parameters: { [`closure:${EXTENT_NAME}`]: declaration as unknown as JsonValue },
    onBlobPopulation: DISCARD_BLOB_POPULATION,
  });
}

/**
 * The closure extent's members, sorted.
 *
 * @param projection - A populated projection
 * @returns Root-relative member paths
 */
function membersOf(projection: Projection): readonly string[] {
  const extentIds = new Set(
    projection.resolutionContexts
      .filter((context) => context.kind === SKILL_KIND)
      .map((context) => context.contextId),
  );
  return projection.resourceRealizations
    .filter((row) => extentIds.has(row.extentId))
    .map((row) => row.path)
    .sort(compareCodeUnits);
}

/**
 * Every corpus FILE the run enumerated at all, in any extent.
 *
 * The guard that keeps every "is not a member" assertion below non-vacuous: a
 * path absent from the closure because the fixture never wrote it would read
 * exactly like a path absent because nothing links to it.
 *
 * @param projection - A populated projection
 * @returns Root-relative paths of enumerated non-directory rows, deduplicated
 */
function enumeratedFilesOf(projection: Projection): readonly string[] {
  return [
    ...new Set(
      projection.resourceRealizations
        .filter((row) => !row.isDirectory)
        .map((row) => row.path),
    ),
  ].sort(compareCodeUnits);
}

/**
 * The parser kind that keyed a path's bytes, read off its content key's prefix.
 *
 * @param projection - A populated projection
 * @param path - A root-relative corpus path
 * @returns The `ParserKind` prefix of that path's content key
 */
function parserKindOf(projection: Projection, path: string): string {
  const key = projection.resourceRealizations.find(
    (row) => row.path === path && row.contentKey !== null,
  )?.contentKey;
  expect(key, `no keyed realization for ${path}`).toBeTypeOf('string');
  return (key ?? '').slice(0, (key ?? '').indexOf('.'));
}

/**
 * Every reference row emitted from one path's bytes.
 *
 * @param projection - A populated projection
 * @param path - A root-relative corpus path
 * @returns `[rawRef, syntacticForm]` pairs in row order
 */
function referencesFrom(projection: Projection, path: string): readonly (readonly [string, string])[] {
  const keys = new Set(
    projection.resourceRealizations
      .filter((row) => row.path === path && row.contentKey !== null)
      .map((row) => row.contentKey),
  );
  return projection.blobReferences
    .filter((row) => keys.has(row.blob))
    .map((row) => [row.rawRef, row.syntacticForm] as const);
}

describe('filesystem extent narrowing', () => {
  it('admits the script as a DIRECT member: markdown links to a file no parser reads', async () => {
    // The control. Without this the narrowed arm below proves nothing: a member
    // that never existed cannot be lost. Membership does not depend on the
    // TARGET being parseable — only on the referring blob's form being followed.
    const projection = await populateCorpus(false);

    expect(enumeratedFilesOf(projection)).toStrictEqual(CORPUS_FILES);
    expect(membersOf(projection)).toStrictEqual([ROOT_DOC, SCRIPT].sort(compareCodeUnits));
    expect(membersOf(projection)).toHaveLength(2);
    expect(referencesFrom(projection, ROOT_DOC)).toStrictEqual([[SCRIPT, 'markdown-link']]);
    expect(parserKindOf(projection, ROOT_DOC)).toBe('markdown');
  });

  it('is a dead end, not a door: the script names the leaf twice and reaches it never', async () => {
    // 🪤 This arm REPLACES "follows the script hop because a JSDoc comment IS
    // markdown". That arm's subject is gone: a `.mjs` routes to no document
    // parser, so the JSDoc reference is no longer an AST `markdown-link`. What
    // is measured here instead is the mechanism of the *re-derived* verdict —
    // the script still carries references, and not one of them is in `follow`.
    const projection = await populateCorpus(false);
    const fromScript = referencesFrom(projection, SCRIPT);

    // Non-vacuity, in order: the leaf is on disk and enumerated; the script DID
    // emit references; only then does "none of them is followed" mean anything.
    expect(enumeratedFilesOf(projection)).toContain(LEAF_DOC);
    expect(parserKindOf(projection, SCRIPT)).toBe('none');
    expect(fromScript).toStrictEqual([
      [`note](../${LEAF_DOC}`, 'bare-token'],
      [`readFileSync('${LEAF_DOC}`, 'bare-token'],
    ]);
    expect(fromScript).toHaveLength(2);
    expect(fromScript.filter(([, form]) => DEFAULT_FOLLOW.includes(form))).toStrictEqual([]);
    expect(DEFAULT_FOLLOW).toStrictEqual([
      'markdown-link',
      'markdown-link-reference',
      'markdown-definition',
    ]);

    // The consequence, stated as membership rather than left as an inference.
    expect(membersOf(projection)).not.toContain(LEAF_DOC);
  });

  it('loses the script — a direct link target of its own root — when non-markdown is withheld', async () => {
    // The verdict. The loss is now DIRECT only: the leaf was never a member, so
    // narrowing cannot cost it. Asserted as a difference against the control so
    // the arm names exactly which member disappears and how many.
    const wide = membersOf(await populateCorpus(false));
    const narrow = membersOf(await populateCorpus(true));

    expect(narrow).toStrictEqual([ROOT_DOC]);
    expect(wide.filter((path) => !narrow.includes(path))).toStrictEqual([SCRIPT]);
    expect(wide).toHaveLength(2);
    expect(narrow).toHaveLength(1);
  });

  it('reports the withheld script as a refusal rather than dropping it in silence', async () => {
    const refusals = (await populateCorpus(true)).realizationConditions.filter(
      (condition) => condition.code === NARROWED,
    );

    expect(refusals).toHaveLength(1);
  });
});
