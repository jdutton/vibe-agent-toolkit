import { createHash } from 'node:crypto';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { LOADING_TAG } from '../src/projection/agentic-tags.js';
import {
  CLAUDE_RULES_SCOPE_KIND,
  ClaudeRulesScopeContributor,
  RULE_SCOPE_TAG,
  ruleScopeFor,
} from '../src/projection/contributors/claude-rules-scope.js';
import { ProjectionBuilder, type ProjectionBase } from '../src/projection/projection.js';
import type { BlobRow } from '../src/schemas/projection-blobs.js';
import type { JsonValue } from '../src/schemas/projection-shared.js';

import { projectionRealizationRow } from './test-helpers.js';

/** A root that is never touched on disk — this classifier reads rows, not files. */
const ROOT = '/vat-corpus/rules-scope-fixture';

/** The extent the hand-built base realizes its files in. */
const BASE_EXTENT = 'ctx-filesystem-fixture';

/** A paths-less rule directly under the PROJECT-ROOT `.claude/rules/`. */
const ROOT_RULE = '.claude/rules/style.md';

/** A rule carrying `paths:`, in the same directory — the file-vs-directory asymmetry. */
const SCOPED_RULE = '.claude/rules/typescript.md';

/** A paths-less rule under a NESTED `.claude/rules/`, which the vendor calls on-demand. */
const NESTED_RULE = 'packages/cli/.claude/rules/local.md';

/** A non-empty `paths:` list — the frontmatter that makes a rule path-scoped. */
const TS_GLOBS = ['**/*.ts'];

/** The scope a `paths:`-carrying rule gets, spelled once. */
const PATH_SCOPED = 'path-scoped';

describe('ruleScopeFor', () => {
  it('calls a paths-less rule directly under the project root "root"', () => {
    // Loads at launch with the same priority as `.claude/CLAUDE.md`, and that
    // is directory-independent — a tree-global fact.
    expect(ruleScopeFor(ROOT_RULE, null)).toBe('root');
    expect(ruleScopeFor(ROOT_RULE, { description: 'x' })).toBe('root');
  });

  it('calls a rule carrying paths: "path-scoped", wherever it lives', () => {
    // Its predicate needs a path and this classifier has none, so this is the
    // one classification that genuinely does not depend on location.
    expect(ruleScopeFor(SCOPED_RULE, { paths: TS_GLOBS })).toBe(PATH_SCOPED);
    expect(ruleScopeFor('packages/cli/.claude/rules/ts.md', { paths: TS_GLOBS }))
      .toBe(PATH_SCOPED);
  });

  it('calls a paths-less rule in a NESTED .claude/rules "nested"', () => {
    // The vendor puts nested rules directories in the on-demand class alongside
    // path-scoped rules. Without this split, `agentic-tags.ts`'s
    // `underDirectory(p, '.claude/rules')` — which matches at ANY depth — would
    // charge a rule in a package, a fixture, a vendored dependency or a nested
    // worktree to every directory in the tree, with no location column for any
    // consumer to filter it back out.
    expect(ruleScopeFor(NESTED_RULE, null)).toBe('nested');
    expect(ruleScopeFor('.claude/worktrees/wt/.claude/rules/copy.md', null)).toBe('nested');
  });

  it('treats an EMPTY paths list as paths-less', () => {
    // `paths: []` selects nothing, so a rule carrying it has no predicate to be
    // scoped by. Reading it as path-scoped would silently drop a rule that
    // loads — the under-report direction a budget check cannot tolerate.
    expect(ruleScopeFor(ROOT_RULE, { paths: [] })).toBe('root');
  });

  it('treats a non-array paths value as paths-less rather than guessing', () => {
    expect(ruleScopeFor(ROOT_RULE, { paths: 'not-a-list' })).toBe('root');
  });

  it('does not mistake a deeper path under the ROOT rules dir for a nested one', () => {
    // `.claude/rules/` may hold subdirectories. Those are still the PROJECT-ROOT
    // rules directory; "nested" means a second `.claude/` further down the tree.
    expect(ruleScopeFor('.claude/rules/lang/typescript.md', null)).toBe('root');
  });
});

/** A schema-valid content key (`<parserKind>.<sha256>`) derived from a seed. */
function markdownKey(seed: string): string {
  return `markdown.${createHash('sha256').update(seed).digest('hex')}`;
}

/**
 * A schema-valid `blobs` row carrying the one column this contributor reads.
 *
 * Every other column is filled with a real zero rather than cast away: a row
 * that does not satisfy `BlobRowSchema` is not a row the blob stage could
 * produce, and a fixture the producer could never emit is what let the `@`
 * defect ship green in the first place.
 */
function blobRow(contentKey: string, frontmatter: Record<string, JsonValue> | null): BlobRow {
  return {
    contentKey,
    bytes: 0,
    encoding: 'utf-8',
    encodingSource: 'assumed',
    replacementCharacters: 0,
    tokenEstimate: 0,
    frontmatter,
    frontmatterError: null,
    wordCount: 0,
    proseCodeUnits: 0,
    codeBlockCodeUnits: 0,
    linkCount: 0,
    headingCount: 0,
    sectionCount: 0,
  };
}

/** One fixture file: a path and the frontmatter its blob parsed to. */
interface FixtureFile {
  path: string;
  frontmatter: Record<string, JsonValue> | null;
}

/** A base projection holding these files, their blobs, and their identities. */
function buildBase(files: readonly FixtureFile[]): {
  base: ProjectionBase;
  idOf: (path: string) => string;
} {
  const builder = new ProjectionBuilder(ROOT);
  const ids = new Map<string, string>();
  for (const file of files) {
    const resourceId = builder.identities.idFor(safePath.join(ROOT, file.path));
    const contentKey = markdownKey(file.path);
    ids.set(file.path, resourceId);
    builder.addResource({
      resourceId,
      kind: 'file',
      origin: 'filesystem',
      observed: true,
      fromEnumeration: true,
      vatId: null,
    });
    builder.addRealization(projectionRealizationRow({
      resourceId,
      extentId: BASE_EXTENT,
      path: file.path,
      contentKey,
    }));
    builder.addBlob(blobRow(contentKey, file.frontmatter));
  }
  return {
    base: builder.base(),
    idOf: (path) => {
      const id = ids.get(path);
      if (id === undefined) throw new Error(`No fixture file at ${path}`);
      return id;
    },
  };
}

/** The tree every membership case below runs over. */
const RULES_FIXTURE: readonly FixtureFile[] = [
  { path: ROOT_RULE, frontmatter: null },
  { path: SCOPED_RULE, frontmatter: { paths: TS_GLOBS } },
  { path: NESTED_RULE, frontmatter: null },
  { path: 'CLAUDE.md', frontmatter: null },
  { path: 'docs/README.md', frontmatter: null },
];

describe('ClaudeRulesScopeContributor', () => {
  it('tags every rules file with its scope, and nothing else', async () => {
    const { base, idOf } = buildBase(RULES_FIXTURE);

    const contribution = await new ClaudeRulesScopeContributor().contribute(base, null);

    // `CLAUDE.md` and `docs/README.md` are the controls: both are realized,
    // both are markdown, and neither is a rules file — so a classifier that
    // tagged everything would fail here rather than merely over-produce.
    expect(contribution.tags).toEqual([
      { resourceId: idOf(ROOT_RULE), tag: RULE_SCOPE_TAG, value: 'root', source: CLAUDE_RULES_SCOPE_KIND },
      { resourceId: idOf(SCOPED_RULE), tag: RULE_SCOPE_TAG, value: PATH_SCOPED, source: CLAUDE_RULES_SCOPE_KIND },
      { resourceId: idOf(NESTED_RULE), tag: RULE_SCOPE_TAG, value: 'nested', source: CLAUDE_RULES_SCOPE_KIND },
    ]);
  });

  it('makes every tagged identity a member, and nothing else', async () => {
    const { base, idOf } = buildBase(RULES_FIXTURE);
    const contribution = await new ClaudeRulesScopeContributor().contribute(base, null);

    expect(contribution.memberships.map((row) => row.resourceId))
      .toEqual([idOf(ROOT_RULE), idOf(SCOPED_RULE), idOf(NESTED_RULE)]);
  });

  it('emits NO loading tag — agentic-convention stays the only loading producer', async () => {
    // `resource_tags`' key is (resourceId, tag, value, source), so `value` is IN
    // the key: two producers can file `loading='always'` and `loading='selected'`
    // for one identity without colliding, and a GROUP BY resourceId then
    // double-counts. `strongestLoading` exists to hold "exactly one loading row
    // per identity", and a second producer in another stratum silently ends that
    // invariant. Keeping this contributor out of the `loading` vocabulary makes
    // the collision impossible rather than merely unlikely.
    const { base } = buildBase(RULES_FIXTURE);
    const contribution = await new ClaudeRulesScopeContributor().contribute(base, null);

    expect(contribution.tags.filter((row) => row.tag === LOADING_TAG)).toEqual([]);
  });

  it('declares a real extent, so zone_provenance records that it ran', async () => {
    // `runContributor` writes one provenance row PER DECLARED CONTEXT, so a
    // classification contributor returning `contexts: []` has its digest
    // computed and thrown away — nothing records that it ran, and the reuse rule
    // cannot see it. Same reasoning as `agentic-convention.ts`.
    const { base } = buildBase(RULES_FIXTURE);
    const contribution = await new ClaudeRulesScopeContributor().contribute(base, null);

    expect(contribution.contexts).toHaveLength(1);
    expect(contribution.contexts[0]?.kind).toBe(CLAUDE_RULES_SCOPE_KIND);
    expect(contribution.contexts[0]?.species).toBe('extent');
  });

  it('contributes no resources and no realizations', async () => {
    // Every identity it tags was minted by whichever enumerator found its path;
    // re-emitting the rows would claim this contributor discovered them.
    const { base } = buildBase(RULES_FIXTURE);
    const contribution = await new ClaudeRulesScopeContributor().contribute(base, null);

    expect(contribution.resources).toEqual([]);
    expect(contribution.realizations).toEqual([]);
    expect(contribution.conditions).toEqual([]);
  });

  it('reads blobs, and says so — it cannot run in the base stratum', async () => {
    // `populateBlobs` runs BETWEEN the strata, so `blobs.frontmatter` does not
    // exist when base runs. The driver checks `readsBlobs` against a lane's
    // `contentParsing`, so declaring it wrongly would not degrade quietly — it
    // would report a complete, wrong classification.
    const contributor = new ClaudeRulesScopeContributor();
    expect(contributor.readsBlobs).toBe(true);
    expect(contributor.stratum).toBe('closure');
  });

  it('falls back to paths-less for a rule whose blob was never keyed', async () => {
    // A realization can be `deferred` — enumerated, deliberately not read — so
    // the frontmatter lookup misses. Answering `root` rather than throwing is
    // the under-charge-nothing direction: the rule is still located and still
    // tagged, and a consumer sees a scope it can act on.
    const { base, idOf } = buildBase([{ path: ROOT_RULE, frontmatter: null }]);
    const contribution = await new ClaudeRulesScopeContributor().contribute(base, null);

    expect(contribution.tags).toEqual([
      { resourceId: idOf(ROOT_RULE), tag: RULE_SCOPE_TAG, value: 'root', source: CLAUDE_RULES_SCOPE_KIND },
    ]);
  });
});
