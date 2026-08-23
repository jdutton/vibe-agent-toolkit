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

import { addFile } from './helpers/claude-context-fixture.js';

/** A root that is never touched on disk — this classifier reads rows, not files. */
const ROOT = '/vat-corpus/rules-scope-fixture';

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

/**
 * One fixture file: a path, and the markdown whose REAL parse supplies its
 * blob — frontmatter included.
 *
 * 🪤 There is deliberately no hand-built blob row here any more, and no
 * hand-built content key. The key used to be `markdown.sha256(<path>)`, which
 * made this fixture's keys one-to-one with paths — a shape production never
 * has. `content-key.ts` is explicit that a key is a function of bytes and
 * parser kind alone, so `blobs` is a per-CONTENT table and two byte-identical
 * rules files in different directories share ONE row. A path-keyed fixture
 * cannot express that at all, which is exactly how a lens that collapsed two
 * citers into one content key passed every in-memory test and failed only
 * against a real tree. {@link addFile} keys by content, as production does.
 */
interface FixtureFile {
  path: string;
  markdown: string;
  /** Force `contentState: 'deferred'` — enumerated, never read, so no blob. */
  deferred?: boolean;
}

/** A base projection holding these files, their blobs, and their identities. */
function buildBase(files: readonly FixtureFile[]): {
  base: ProjectionBase;
  idOf: (path: string) => string;
} {
  const builder = new ProjectionBuilder(ROOT);
  const ids = new Map<string, string>();
  for (const file of files) {
    ids.set(file.path, builder.identities.idFor(safePath.join(ROOT, file.path)));
    addFile(
      builder,
      { path: file.path, refs: [], markdown: file.markdown, deferred: file.deferred ?? false },
      ROOT,
    );
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

/** A paths-less body — whatever the file says, it declares no `paths:`. */
const NO_FRONTMATTER = '# House style\n\nPrefer clarity over cleverness.\n';

/** Real YAML frontmatter carrying {@link TS_GLOBS}, parsed by the shipped parser. */
const TS_PATHS_FRONTMATTER = '---\npaths:\n  - "**/*.ts"\n---\n\n# TypeScript rules\n';

/** The tree every membership case below runs over. */
const RULES_FIXTURE: readonly FixtureFile[] = [
  { path: ROOT_RULE, markdown: NO_FRONTMATTER },
  { path: SCOPED_RULE, markdown: TS_PATHS_FRONTMATTER },
  { path: NESTED_RULE, markdown: '# Local rules\n\nPackage-specific guidance.\n' },
  { path: 'CLAUDE.md', markdown: '# Project\n' },
  { path: 'docs/README.md', markdown: '# Docs\n' },
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
    //
    // `deferred: true` is the honest spelling of "never keyed": the realization
    // carries `contentKey: null` and there is no `blobs` row at all, which is
    // what the production state looks like. A keyed row whose frontmatter
    // happened to be `null` would exercise the other branch entirely.
    const { base, idOf } = buildBase([{ path: ROOT_RULE, markdown: NO_FRONTMATTER, deferred: true }]);
    const contribution = await new ClaudeRulesScopeContributor().contribute(base, null);

    expect(contribution.tags).toEqual([
      { resourceId: idOf(ROOT_RULE), tag: RULE_SCOPE_TAG, value: 'root', source: CLAUDE_RULES_SCOPE_KIND },
    ]);
  });
});

/** The nested twin of {@link ROOT_RULE} — same basename, same bytes, different depth. */
const NESTED_TWIN = 'packages/cli/.claude/rules/style.md';

describe('ClaudeRulesScopeContributor — two rules files sharing ONE blob', () => {
  /** Both twins, byte-identical, plus nothing else. */
  const TWINS: readonly FixtureFile[] = [
    { path: ROOT_RULE, markdown: NO_FRONTMATTER },
    { path: NESTED_TWIN, markdown: NO_FRONTMATTER },
  ];

  it('files both realizations under ONE content key, as production would', () => {
    // 🪤 The pin that makes the two cases below mean anything. A content key is
    // a function of bytes and parser kind ONLY, so two byte-identical rules
    // files share a key and the `blobs` table holds a single row for both. When
    // this fixture keyed by PATH instead, that many-to-one shape was
    // unreachable: every consumer under test saw a private blob per path and a
    // key→path map looked one-to-one, which is precisely the illusion that let a
    // last-write-wins collapse ship green.
    const { base } = buildBase(TWINS);

    const keys = base.resourceRealizations.map((row) => row.contentKey);
    expect(new Set(keys).size).toBe(1);
    expect(base.blobs).toHaveLength(1);
  });

  it('scopes each PATH on its own, though both read the same bytes', async () => {
    // Scope is a function of LOCATION, and location is the one thing the shared
    // key cannot carry. A classifier that reached for "the path that owns this
    // blob" would answer `root` twice or `nested` twice; the honest answer is
    // one of each, and the identities must differ too — a single tag row here
    // would mean one of the two rules had silently vanished from the budget.
    const { base, idOf } = buildBase(TWINS);

    const contribution = await new ClaudeRulesScopeContributor().contribute(base, null);

    expect(contribution.tags).toEqual([
      { resourceId: idOf(ROOT_RULE), tag: RULE_SCOPE_TAG, value: 'root', source: CLAUDE_RULES_SCOPE_KIND },
      { resourceId: idOf(NESTED_TWIN), tag: RULE_SCOPE_TAG, value: 'nested', source: CLAUDE_RULES_SCOPE_KIND },
    ]);
    expect(contribution.memberships.map((row) => row.resourceId))
      .toEqual([idOf(ROOT_RULE), idOf(NESTED_TWIN)]);
  });

  it('reads the shared blob\'s frontmatter for BOTH twins, not just the last one', async () => {
    // The same shape with `paths:` in the bytes: one blob row, two lookups
    // against it. `path-scoped` is location-independent, so both must get it —
    // and a frontmatter map that had been keyed by anything path-shaped would
    // find the entry for only one of them and silently fall back to paths-less
    // for the other, mislabelling a rule that loads on demand as one that loads
    // at launch.
    const { base, idOf } = buildBase([
      { path: ROOT_RULE, markdown: TS_PATHS_FRONTMATTER },
      { path: NESTED_TWIN, markdown: TS_PATHS_FRONTMATTER },
    ]);

    const contribution = await new ClaudeRulesScopeContributor().contribute(base, null);

    expect(contribution.tags.map((row) => row.value)).toEqual([PATH_SCOPED, PATH_SCOPED]);
    expect(contribution.tags.map((row) => row.resourceId))
      .toEqual([idOf(ROOT_RULE), idOf(NESTED_TWIN)]);
  });
});
