import { describe, expect, it } from 'vitest';

import { claudeAncestry } from '../src/projection/claude-context-ancestry.js';
import {
  whatLoadsAt,
  type LoadedContext,
  type LoadedContextAnswer,
} from '../src/projection/claude-context-query.js';
import { closureProvenance } from '../src/projection/contributors/closure-extent.js';
import type { Projection } from '../src/projection/projection.js';
import { ExtentDeclarationSchema } from '../src/schemas/project-config.js';
import type { RealizationConditionRow } from '../src/schemas/projection-resources.js';

import { claudeContextFixture } from './helpers/claude-context-fixture.js';

/**
 * Assert a result IS an answer, and narrow it.
 *
 * `LoadedContext`'s discriminated union means the narrowing cannot be skipped.
 * Written once: a dozen `answer.kind === 'answer' && …` guards inline would be a
 * dozen places for a case to silently assert nothing when the query returns
 * `unknown` instead of an answer, which is precisely the failure the union
 * exists to make visible.
 *
 * @param answer - Whatever `whatLoadsAt` returned
 * @returns The same value, narrowed
 */
function narrowed(answer: LoadedContext): LoadedContextAnswer {
  expect(answer.kind).toBe('answer');
  if (answer.kind !== 'answer') throw new Error('unreachable — asserted above');
  return answer;
}

/**
 * Build a fixture and take the answer, narrowed.
 *
 * @param files - Root-relative path → markdown source
 * @param path - The path to query
 * @returns The answer, having asserted it IS an answer
 */
async function answerAt(
  files: Record<string, string>,
  path: string,
): Promise<LoadedContextAnswer> {
  return narrowed(whatLoadsAt(await claudeContextFixture(files), path));
}

/** The paths of an answer's rows, in the order the query returned them. */
function pathsOf(answer: LoadedContextAnswer): string[] {
  return answer.rows.map((row) => row.path);
}

/** The one row at a path, or undefined — every case here queries by path. */
function rowAt(answer: LoadedContextAnswer, path: string): LoadedContextAnswer['rows'][number] | undefined {
  return answer.rows.find((row) => row.path === path);
}

/**
 * A chain `CLAUDE.md → docs/handbook.md → docs/deep.md`, so depth 2 is reachable.
 *
 * ⚠️ `docs/handbook.md` imports `@deep.md`, NOT `@docs/deep.md`. A reference
 * resolves against the **referring file's** directory (`resolveReference` in
 * `closure-extent.ts` joins `rawRef` onto `fromPath`'s directory), so the
 * second spelling resolves to `docs/docs/deep.md` and lands
 * `CLOSURE_REFERENCE_UNRESOLVED` — a chain of length one wearing a length-two
 * fixture's clothes, which is exactly the shape of fixture that cannot
 * distinguish a working depth counter from a broken one.
 */
const IMPORT_CHAIN: Record<string, string> = {
  'CLAUDE.md': '@docs/handbook.md\n',
  'docs/handbook.md': '@deep.md\n',
  'docs/deep.md': 'x\n',
};

/** Two roots into one target — the diamond `resourceId` dedup has to collapse. */
const DIAMOND: Record<string, string> = {
  'CLAUDE.md': '@a.md\n@b.md\n',
  'a.md': '@shared.md\n',
  'b.md': '@shared.md\n',
  'shared.md': 'x\n',
};

/** The diamond's join point. */
const SHARED = 'shared.md';

/** The corpus root's own `CLAUDE.md` — every fixture chain below starts here. */
const ROOT_CLAUDE_MD = 'CLAUDE.md';

/** A nested `CLAUDE.md` that is ALSO its parent's import target. */
const NESTED_CLAUDE_MD = 'docs/CLAUDE.md';

/** A rules file under `sub/`, so `ruleScopeFor` calls it `nested`, not `root`. */
const NESTED_RULE = 'sub/.claude/rules/x.md';

/** The nested rule's own `@`-import target, alongside it in the rules directory. */
const NESTED_RULE_HELPER = 'sub/.claude/rules/helper.md';

/** A root rules file carrying `paths:`, so `ruleScopeFor` calls it `path-scoped`. */
const SCOPED_RULE = '.claude/rules/scoped.md';

/** The rule's own `@`-import target — the closure a wrong class would drag with it. */
const SCOPED_RULE_HELPER = 'docs/scoped-helper.md';

/** The `paths:` entry, spelled once so the admission assertion cannot drift from the fixture. */
const SCOPED_RULE_PATTERN = 'src/**/*.ts';

/** A file the pattern above matches exactly — the FILE query's subject. */
const SCOPED_RULE_SUBJECT = 'src/a.ts';

/**
 * A matching path-scoped rule that also imports, plus a root `CLAUDE.md`.
 *
 * The `CLAUDE.md` is the CONTROL: without a file that genuinely does load at
 * launch, "the rule is not in the always set" is equally satisfied by a query
 * that classes nothing `always` at all.
 */
const SCOPED_RULE_TREE: Record<string, string> = {
  [ROOT_CLAUDE_MD]: 'root\n',
  [SCOPED_RULE]: `---\npaths: ['${SCOPED_RULE_PATTERN}']\n---\n\n@../../${SCOPED_RULE_HELPER}\n`,
  [SCOPED_RULE_HELPER]: 'helper\n',
  [SCOPED_RULE_SUBJECT]: 'export const a = 1;\n',
};

/**
 * A four-hop chain into {@link NESTED_RULE}, whose own import is the FIFTH hop.
 *
 * `maxDepth: 4` (`claude-import-extent.ts`, vendor-documented) admits the rule
 * file at depth 4 and refuses {@link NESTED_RULE_HELPER} at depth 5 — so the
 * helper is reachable ONLY through the rule file's own closure, and its load
 * class can only be right if the rule file's class (itself `always` purely by
 * import) propagates. A single lookup of the closure root's own admissions
 * answers `on-demand` here.
 */
const DEPTH_CAPPED_CHAIN: Record<string, string> = {
  [ROOT_CLAUDE_MD]: '@h1.md\n',
  'h1.md': '@h2.md\n',
  'h2.md': '@h3.md\n',
  'h3.md': `@${NESTED_RULE}\n`,
  [NESTED_RULE]: '@helper.md\n',
  [NESTED_RULE_HELPER]: 'helper\n',
};

describe('whatLoadsAt', () => {
  it('returns a distinguishable unknown for a path the projection never realized', async () => {
    const projection = await claudeContextFixture({ 'CLAUDE.md': 'root\n' });

    expect(whatLoadsAt(projection, 'not/here')).toEqual({
      kind: 'unknown',
      input: 'not/here',
      reason: 'path-not-realized',
    });
  });

  it('answers zero rows — not unknown — for a realized directory with no instruction files', async () => {
    const answer = await answerAt({ 'src/index.ts': 'x\n' }, 'src');

    expect(answer.rows).toEqual([]);
    expect(answer.directory).toBe('src');
  });

  it('resolves a FILE input to its parent directory and keeps the file', async () => {
    const answer = await answerAt({ 'CLAUDE.md': 'root\n', 'src/a.ts': 'x\n' }, 'src/a.ts');

    expect(answer.directory).toBe('src');
    expect(answer.file).toBe('src/a.ts');
  });

  it('carries import provenance — which file pulled it in, at what depth', async () => {
    const answer = await answerAt(IMPORT_CHAIN, '');

    expect(rowAt(answer, 'docs/deep.md')?.admissions).toEqual([
      { kind: 'import', rootPath: 'CLAUDE.md', viaPath: 'docs/handbook.md', depth: 2 },
    ]);
    expect(answer.unattributedImports).toEqual([]);
  });

  it('charges a diamond target ONCE, carrying the one admission the walk recorded', async () => {
    const answer = await answerAt(DIAMOND, '');

    expect(pathsOf(answer).filter((path) => path === SHARED)).toEqual([SHARED]);
    // ⚠️ ONE admission, not two. The closure's visited set admits `shared.md`
    // on whichever edge reaches it first, so the diamond's second edge is not
    // an admission — it is a hop the traversal declined. A row claiming two
    // would be inventing a provenance the walk never recorded.
    expect(rowAt(answer, SHARED)?.admissions).toHaveLength(1);
  });

  it('charges an ancestor that is ALSO an import target once, with both admissions', async () => {
    const answer = await answerAt(
      { 'CLAUDE.md': '@docs/CLAUDE.md\n', [NESTED_CLAUDE_MD]: 'nested\n' },
      'docs',
    );

    expect(pathsOf(answer).filter((path) => path === NESTED_CLAUDE_MD)).toEqual([NESTED_CLAUDE_MD]);
    expect(rowAt(answer, NESTED_CLAUDE_MD)?.admissions.map((a) => a.kind).sort()).toEqual([
      'ancestry',
      'import',
    ]);
  });

  it('never re-admits a closure root as an import of itself', async () => {
    const answer = await answerAt(IMPORT_CHAIN, '');

    // The root is in the answer by ANCESTRY and by nothing else: it was seeded
    // into its own traversal rather than reached by a reference, so an `import`
    // admission here would name a hop that never happened.
    expect(rowAt(answer, 'CLAUDE.md')?.admissions).toEqual([{ kind: 'ancestry', dir: '' }]);
  });

  it('does not charge a closure rooted at a CLAUDE.md this query never reached', async () => {
    const answer = await answerAt(
      {
        'CLAUDE.md': 'root\n',
        // Two references, each a control for a different half of the claim.
        // `@aside.md` is relative to `other/`, so it really does reach
        // `other/aside.md` — without it the row assertion would also pass on a
        // closure that resolved nothing. `@totally/missing.md` really does
        // land a CLOSURE_REFERENCE_UNRESOLVED — without it the condition
        // assertion would also pass on a tree-global grader, because the
        // sibling closure would have had nothing to report either way.
        'other/CLAUDE.md': '@aside.md\n@totally/missing.md\n',
        'other/aside.md': 'x\n',
      },
      '',
    );

    // `other/CLAUDE.md` is a sibling directory's launch-time file, not this
    // query's, so neither it nor its import subtree is this session's context —
    // and an answer that refused to CHARGE that closure must not WARN about it
    // either.
    expect(pathsOf(answer)).toEqual(['CLAUDE.md']);
    expect(answer.conditions).toEqual([]);
  });

  it('never lowers a STORED severity — an error condition renders as error, not info', async () => {
    const projection = await claudeContextFixture({ 'CLAUDE.md': 'root\n' });
    const answer = narrowed(whatLoadsAt(withCondition(projection, rootAbsentRow(projection)), ''));

    // A declared import root the population never realized is a real
    // misconfiguration. Re-deriving severity from the CODE alone reported it as
    // quietly as a `@jeff` mention.
    expect(answer.conditions.find((c) => c.code === 'CLOSURE_ROOT_ABSENT')?.severity).toBe('error');
  });

  it('escalates a PATH-SHAPED unresolved import to warn and leaves a bare @token at info', async () => {
    // ⚠️ The two tokens are in DIFFERENT files on purpose.
    // `realization_conditions` is keyed `(extentId, path, code, resourceId)`
    // (`projection.ts`), so two unresolved references out of ONE file collapse
    // to a single stored row — see the task report's finding. Splitting them
    // keeps both rows, which is what this case is actually about.
    const answer = await answerAt(
      { 'CLAUDE.md': '@docs/missing.md\n@notes.md\n', 'notes.md': 'thanks @jeff\n' },
      '',
    );

    expect(answer.conditions.find((c) => c.sourceRef === '@docs/missing.md')?.severity).toBe('warn');
    expect(answer.conditions.find((c) => c.sourceRef === '@jeff')?.severity).toBe('info');
  });

  it('never escalates an escaping import, however path-shaped', async () => {
    const answer = await answerAt({ 'CLAUDE.md': '@~/.claude/shared.md\n' }, '');
    const outside = answer.conditions.filter((c) => c.code === 'CLOSURE_REFERENCE_OUTSIDE_ROOT');

    expect(outside).toHaveLength(1);
    expect(outside[0]?.severity).toBe('info');
    // The token is as path-shaped as they come — an extension and two slashes —
    // so a grader that escalated on shape alone would fire here.
    expect(outside[0]?.sourceRef).toBe('@~/.claude/shared.md');
  });

  it('reports tokens as unknown, never 0, when the member has no blob', async () => {
    const projection = await claudeContextFixture({ 'CLAUDE.md': 'root\n' }, { deferred: ['CLAUDE.md'] });
    const answer = narrowed(whatLoadsAt(projection, ''));

    expect(answer.rows[0]?.path).toBe('CLAUDE.md');
    expect(answer.rows[0]?.tokens).toBeNull();
    expect(answer.rows[0]?.bytes).toBeNull();
  });

  it('reports a real token count when the member does have a blob', async () => {
    const answer = await answerAt({ 'CLAUDE.md': 'root\n' }, '');

    // The control for the case above: `toBeNull()` alone is also satisfied by a
    // query that never reads `blobs` at all.
    expect(rowAt(answer, 'CLAUDE.md')?.tokens).toBeGreaterThan(0);
    expect(rowAt(answer, 'CLAUDE.md')?.bytes).toBe(5);
  });

  it('classes a NESTED rules file on-demand and a ROOT one always', async () => {
    const nested = await answerAt({ [NESTED_RULE]: 'nested rule\n' }, 'sub');
    const root = await answerAt({ '.claude/rules/y.md': 'root rule\n' }, '');

    expect(rowAt(nested, NESTED_RULE)?.loadClass).toBe('on-demand');
    expect(rowAt(nested, NESTED_RULE)?.admissions).toEqual([
      { kind: 'nested-rule', under: 'sub' },
    ]);
    expect(rowAt(root, '.claude/rules/y.md')?.loadClass).toBe('always');
  });

  it('classes a path-scoped rule ON DEMAND even when a FILE query matches its glob', async () => {
    const answer = await answerAt(SCOPED_RULE_TREE, SCOPED_RULE_SUBJECT);
    const row = rowAt(answer, SCOPED_RULE);

    // ⛔ The admission is the exact match — the glob fired — and the class is
    // still `on-demand`. The vendor's on-demand class is "rules that load on
    // demand, INCLUDING path-scoped rules and rules in nested .claude/rules/
    // directories"; an earlier draft acted on the second half and classed a
    // matched `glob-rule` as `always`, charging the rule and its whole @-import
    // closure to the launch-time budget this command exists to report.
    expect(row?.admissions).toEqual([{ kind: 'glob-rule', pattern: SCOPED_RULE_PATTERN }]);
    expect(row?.loadClass).toBe('on-demand');
  });

  it('gives a path-scoped rule the SAME class for the file and the directory above it', async () => {
    const file = rowAt(await answerAt(SCOPED_RULE_TREE, SCOPED_RULE_SUBJECT), SCOPED_RULE);
    const directory = rowAt(await answerAt(SCOPED_RULE_TREE, 'src'), SCOPED_RULE);

    // The tell that `always` could never have been right. A directory query is
    // the LESS precise question about the same rule file, and precision about
    // the query cannot change when the harness loads the file — so if these two
    // classes disagree, one of them is wrong by construction.
    expect(directory?.admissions).toEqual([
      { kind: 'glob-rule-may-fire', pattern: SCOPED_RULE_PATTERN, examplePath: SCOPED_RULE_SUBJECT },
    ]);
    expect(file?.loadClass).toBe(directory?.loadClass);
  });

  it('keeps a path-scoped rule OUT of the always-loaded budget, closure and all', async () => {
    const answer = await answerAt(SCOPED_RULE_TREE, SCOPED_RULE_SUBJECT);
    const always = answer.rows.filter((row) => row.loadClass === 'always').map((row) => row.path);

    // The consequence, asserted where a consumer sees it: neither the rule nor
    // what it imports may appear in the launch-time set, and `CLAUDE.md` must —
    // a suite asserting only the absence would also pass on a query that classed
    // everything `on-demand`.
    expect(always).toEqual([ROOT_CLAUDE_MD]);
  });

  it('lets `always` win over `on-demand` when one identity carries both', async () => {
    // The nested rules file is reached by the root `CLAUDE.md`'s import closure
    // AND admitted as a nested rule for this directory. Reporting the weaker
    // class would under-report a file the harness loads at launch.
    const answer = await answerAt(
      {
        'CLAUDE.md': `@${NESTED_RULE}\n`,
        [NESTED_RULE]: 'nested rule\n',
      },
      'sub',
    );
    const row = rowAt(answer, NESTED_RULE);

    expect(row?.admissions.map((a) => a.kind).sort()).toEqual(['import', 'nested-rule']);
    expect(row?.loadClass).toBe('always');
  });

  it('renders a member it cannot attribute as unknown rather than inventing a parent', async () => {
    const projection = await withStrayMembership({
      'CLAUDE.md': '@docs/handbook.md\n',
      'docs/handbook.md': 'x\n',
    });
    const answer = narrowed(whatLoadsAt(projection, ''));

    expect(answer.rows.find((row) => row.path === STRAY)?.admissions).toEqual([
      { kind: 'import', rootPath: 'CLAUDE.md', viaPath: null, depth: null },
    ]);
    expect(answer.unattributedImports).toEqual([STRAY]);
  });

  it('lists an unattributable member ONCE even when two charged closures hold it', async () => {
    // Two import roots, both admitted by ancestry from `docs`, and one stray
    // membership filed under EACH. `unattributedImports` is the set of paths the
    // answer cannot explain, not a tally of how often it failed to.
    const projection = await withStrayMembership({
      'CLAUDE.md': 'root\n',
      [NESTED_CLAUDE_MD]: 'nested\n',
    });
    const answer = narrowed(whatLoadsAt(projection, 'docs'));

    expect(answer.unattributedImports).toEqual([STRAY]);
  });

  it('throws rather than answering zero import closures for a rootless projection', async () => {
    const projection = await claudeContextFixture(IMPORT_CHAIN);

    // Every reference resolves against the root, so a rootless projection cannot
    // be answered — and "no imports" is the one wrong answer indistinguishable
    // from the right one.
    expect(() => whatLoadsAt({ ...projection, roots: [] }, '')).toThrow(/no root/);
  });

  it('classes an import member by its closure ROOT, so an on-demand root pulls in on-demand members', async () => {
    const answer = await answerAt(
      { [NESTED_RULE]: '@helper.md\n', [NESTED_RULE_HELPER]: 'helper\n' },
      'sub',
    );

    // Nothing in this projection loads either file at launch: the importer is a
    // nested rules file the session loads on demand, so what it imports is on
    // demand too. Reading the `import` admission alone said `always` and
    // over-charged the launch-time budget.
    expect(rowAt(answer, NESTED_RULE)?.loadClass).toBe('on-demand');
    expect(rowAt(answer, NESTED_RULE_HELPER)?.loadClass).toBe('on-demand');
  });

  it('propagates a launch-time class through a root that is itself only always BY import', async () => {
    const answer = await answerAt(DEPTH_CAPPED_CHAIN, 'sub');

    // The rule file is `always` only because the root `CLAUDE.md`'s closure
    // reaches it at the fourth hop; the helper is beyond that closure's budget
    // and reachable only through the rule file's OWN closure. Both are loaded at
    // launch, and only a fixpoint over the whole admission set says so.
    expect(rowAt(answer, NESTED_RULE)?.loadClass).toBe('always');
    expect(rowAt(answer, NESTED_RULE_HELPER)?.loadClass).toBe('always');
  });

  it('keeps the provenance map a SUBSET of the extent membership it labels', async () => {
    const projection = await claudeContextFixture({ ...DIAMOND, 'unreferenced.md': 'y\n' });
    const provenanceRow = projection.zoneProvenance[0];
    if (provenanceRow === undefined) throw new Error('fixture produced no import extent');

    const members = memberPathsOf(projection, provenanceRow.contextId);
    const provenance = closureProvenance({
      root: projection.roots[0]?.path ?? '',
      resourceRealizations: projection.resourceRealizations,
      blobReferences: projection.blobReferences,
      declaration: ExtentDeclarationSchema.parse(provenanceRow.parameterSet),
    });

    // Membership is the AUTHORITY, provenance only the LABEL: the re-walk may
    // fail to attribute a member, but it must never admit one the contributor
    // refused. `unreferenced.md` is the control — realized, never referenced,
    // and therefore in neither set.
    expect([...provenance.keys()].filter((path) => !members.has(path))).toEqual([]);
    expect(members.has('unreferenced.md')).toBe(false);
    expect(members.has('shared.md')).toBe(true);
  });

  it('reports the ancestry chain root-down, and nothing above the query', async () => {
    const files = {
      'CLAUDE.md': 'root\n',
      'a/CLAUDE.md': 'a\n',
      'a/b/CLAUDE.md': 'b\n',
      'z/CLAUDE.md': 'z\n',
    };
    const answer = await answerAt(files, 'a/b');
    const projection = await claudeContextFixture(files);

    expect(pathsOf(answer)).toEqual(['CLAUDE.md', 'a/CLAUDE.md', 'a/b/CLAUDE.md']);
    // `rows` is path-ordered, which coincides with render order here. The chain
    // itself is the ancestry primitive's, and this pins that the query does not
    // drop or reorder it.
    expect(
      claudeAncestry(projection.resourceRealizations, projection.resourceTags, 'a/b').map((e) => e.path),
    ).toEqual(['CLAUDE.md', 'a/CLAUDE.md', 'a/b/CLAUDE.md']);
  });
});

/**
 * Every root-relative path the projection files under one extent.
 *
 * @param projection - The populated projection
 * @param extentId - The extent's `resolution_contexts.contextId`
 * @returns The member paths
 */
function memberPathsOf(projection: Projection, extentId: string): Set<string> {
  const pathOf = new Map(projection.resourceRealizations.map((row) => [row.resourceId, row.path]));
  const paths = new Set<string>();
  for (const membership of projection.resourceExtents) {
    if (membership.extentId !== extentId) continue;
    const path = pathOf.get(membership.resourceId);
    if (path !== undefined) paths.add(path);
  }
  return paths;
}

/** The member every import extent below is made to hold and cannot explain. */
const STRAY = 'stray.md';

/**
 * A projection whose EVERY import extent holds one member the traversal never
 * reaches.
 *
 * The case is unreachable through the fixture's own contributors — membership
 * and provenance agree by construction there — so it is built by appending
 * membership rows to a finished projection. That is exactly the shape a
 * store-rehydrated projection has: `resource_extents` is the materialised
 * authority, and the provenance walk is re-run against it. A member the walk
 * cannot attribute must render `via: unknown`, never a plausible parent.
 *
 * Filed under every extent rather than the first, so a `files` map declaring two
 * import roots produces the two-closure case; a map declaring one is unchanged.
 *
 * @param files - Root-relative path → markdown, WITHOUT the stray file
 * @returns The projection, with `stray.md` filed under every import closure
 */
async function withStrayMembership(files: Record<string, string>): Promise<Projection> {
  const projection = await claudeContextFixture({ ...files, [STRAY]: 'y\n' });
  const extentIds = projection.zoneProvenance.map((row) => row.contextId);
  const stray = projection.resourceRealizations.find((row) => row.path === STRAY);
  if (extentIds.length === 0 || stray === undefined) throw new Error('fixture is missing its inputs');

  return {
    ...projection,
    resourceExtents: [
      ...projection.resourceExtents,
      ...extentIds.map((extentId) => ({ resourceId: stray.resourceId, extentId })),
    ],
  };
}

/**
 * A `CLOSURE_ROOT_ABSENT` row at the severity its real producer emits.
 *
 * Injected rather than provoked, because the shipped detector only fires for a
 * declaration naming an unrealized root and the fixture derives its declarations
 * FROM the realizations — so no `{path: markdown}` map can produce one. Filed
 * under the base extent, which is never an import closure and so is never
 * scoped out of the answer.
 *
 * @param projection - The fixture projection to anchor the row to
 * @returns The condition row
 */
function rootAbsentRow(projection: Projection): RealizationConditionRow {
  const realization = projection.resourceRealizations.find((row) => row.path === ROOT_CLAUDE_MD);
  if (realization === undefined) throw new Error('fixture is missing its CLAUDE.md');
  return {
    extentId: realization.extentId,
    path: ROOT_CLAUDE_MD,
    code: 'CLOSURE_ROOT_ABSENT',
    severity: 'error',
    message: 'the declared closure root realizes nowhere in this population',
    resourceId: realization.resourceId,
    sourcePath: null,
    sourceLine: null,
    sourceRef: null,
    targetExists: null,
    matchedPattern: null,
    matchedPayload: null,
  };
}

/**
 * The projection with one more condition row.
 *
 * @param projection - The fixture projection
 * @param condition - The row to append
 * @returns A projection carrying it
 */
function withCondition(projection: Projection, condition: RealizationConditionRow): Projection {
  return {
    ...projection,
    realizationConditions: [...projection.realizationConditions, condition],
  };
}
