/**
 * The deciding fixture for the filesystem extent's **narrowing** claim.
 *
 * `filesystem-extent.ts` ends its header with "this extent cannot be narrowed —
 * dropping non-markdown loses real members". That was reasoned and never
 * measured, and it is the sentence cited to justify keying non-markdown files,
 * so it is worth a corpus rather than an argument. Two facts made it doubtful:
 * no fixture linked *through* a script, and `ExtentDeclarationSchema.follow`
 * defaults to the three markdown forms only.
 *
 * ## The corpus, and why this shape
 *
 * `SKILL.md` → `scripts/tool.mjs` → `docs/note.md`: the leaf is reachable ONLY
 * through the non-markdown hop, so "narrowing loses nothing" and "narrowing
 * loses the leaf" are distinguishable outcomes rather than one silent one. A
 * corpus whose leaf were also linked from `SKILL.md` could not tell them apart.
 *
 * The script's reference to the leaf is written the way a real script writes one
 * — inside a JSDoc comment, which is markdown — and the file also carries a bare
 * `readFileSync('docs/note.md')` path token. Both spellings are in the corpus on
 * purpose: they lex to *different* syntactic forms and only one of them is
 * followed, which is the precondition the verdict below rests on.
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
import { populate } from '../src/projection/merge.js';
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

/** The rule that stands in for "the extent enumerated no non-markdown file". */
const NARROWED = 'non-markdown-withheld';

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

describe('filesystem extent narrowing', () => {
  it('reaches the leaf THROUGH the script, so the non-markdown row is load-bearing', async () => {
    // The control. Without this the narrowed arm below proves nothing: a leaf
    // that was never a member cannot be lost.
    expect(membersOf(await populateCorpus(false)))
      .toStrictEqual([ROOT_DOC, LEAF_DOC, SCRIPT].sort(compareCodeUnits));
  });

  it('loses the script AND the leaf reachable only through it when non-markdown is withheld', async () => {
    // The verdict: narrowing costs a DIRECT member (the script is a link target
    // of the root) and a TRANSITIVE one (the leaf is reachable no other way).
    expect(membersOf(await populateCorpus(true))).toStrictEqual([ROOT_DOC]);
  });

  it('reports the withheld script as a refusal rather than dropping it in silence', async () => {
    const refusals = (await populateCorpus(true)).realizationConditions.filter(
      (condition) => condition.code === NARROWED,
    );

    expect(refusals).toHaveLength(1);
  });

  it('follows the script hop because a JSDoc comment IS markdown — the precondition of the verdict', async () => {
    // 🪤 The verdict above holds because the script's reference lexes as
    // `markdown-link`, which the DEFAULT `follow` set contains. Its bare
    // `readFileSync('docs/note.md')` token lexes as `bare-token` and is NOT
    // followed. So the proven property is "non-markdown files carry followed
    // references", not "every path a script names is traversed" — and if the
    // default `follow` ever widens to `bare-token`, this assertion goes red and
    // the claim above has to be re-measured against the wider set.
    const forms = new Map(
      (await populateCorpus(false)).blobReferences.map((row) => [row.rawRef, row.syntacticForm]),
    );

    expect(forms.get(`../${LEAF_DOC}`)).toBe('markdown-link');
    expect(forms.get(`readFileSync('${LEAF_DOC}`)).toBe('bare-token');
    expect(ExtentDeclarationSchema.parse({ kind: SKILL_KIND, closureFrom: ROOT_DOC }).follow)
      .toStrictEqual(['markdown-link', 'markdown-link-reference', 'markdown-definition']);
  });
});
