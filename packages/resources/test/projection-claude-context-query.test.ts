import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { estimateTokens } from '../src/link-classify.js';
import { account } from '../src/projection/claude-context-accounting.js';
import { claudeAncestry } from '../src/projection/claude-context-ancestry.js';
import {
  whatLoadsAt,
  type LoadedContext,
  type LoadedContextAnswer,
} from '../src/projection/claude-context-query.js';
import { closureProvenance } from '../src/projection/contributors/closure-extent.js';
import {
  EXTENT_SYMLINK_NOT_REALIZED,
  EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT,
  isDeclinedSymlinkCode,
} from '../src/projection/contributors/filesystem-extent.js';
import { CLAUDE_CODE } from '../src/projection/harness/claude-code.js';
import { HarnessFactsAbsentError } from '../src/projection/harness/facts-index.js';
import type { MemoryKind } from '../src/projection/harness/profile.js';
import type { Projection } from '../src/projection/projection.js';
import { ExtentDeclarationSchema } from '../src/schemas/project-config.js';
import type { RealizationConditionRow } from '../src/schemas/projection-resources.js';

import { CLAUDE_CONTEXT_FIXTURE_ROOT, claudeContextFixture } from './helpers/claude-context-fixture.js';

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

/**
 * A root rules file whose own NAME collides with the `CLAUDE.local.md` slot
 * name — a rules file is ALWAYS `Project` in the vendor's own model, however
 * it happens to be named, and a `kind` test that re-derives from the basename
 * alone mislabels this one `Local`.
 */
const MISNAMED_RULES_FILE = '.claude/rules/CLAUDE.local.md';

/**
 * `acme/CLAUDE.md` (importing `acme/docs/a.md`) plus `acme/CLAUDE.local.md`
 * (importing `acme/docs/b.md`), plus a root rules file literally NAMED
 * `CLAUDE.local.md` — launched at `acme`. Exercises every source
 * `headerTokensFor`'s `kind` reads: a `Project` ancestry file, a `Project`
 * import, a `Local` ancestry file, a `Local`-BY-INHERITANCE import (an import
 * rooted at the LOCAL file inherits `Local`, not re-derived from its own
 * basename — `acme/docs/b.md` names nothing `.local`), and a rules file whose
 * name collides with the `Local` slot but stays `Project` regardless
 * ({@link MISNAMED_RULES_FILE}).
 */
const HEADER_TREE: Record<string, string> = {
  'acme/CLAUDE.md': '@docs/a.md\n\nRoot instructions for acme.\n',
  'acme/docs/a.md': 'Imported handbook content.\n',
  'acme/CLAUDE.local.md': '@docs/b.md\n\nLocal, uncommitted instructions.\n',
  'acme/docs/b.md': 'Locally imported content.\n',
  [MISNAMED_RULES_FILE]: 'An unscoped rule, oddly named like the Local slot. Always Project.\n',
};

/**
 * Every {@link HEADER_TREE} path's expected `kind` — the mutation-guard table
 * the loop below checks. `chainRoot = path` (ignoring an import's `rootPath`)
 * passes `acme/CLAUDE.md` and `acme/docs/a.md` either way (both are `Project`
 * under either rule) but fails `acme/docs/b.md` (whose own basename is not
 * `.local`), which is exactly why that row is in the table.
 */
const HEADER_TREE_KIND: ReadonlyMap<string, MemoryKind> = new Map([
  ['acme/CLAUDE.md', 'Project'],
  ['acme/docs/a.md', 'Project'],
  ['acme/CLAUDE.local.md', 'Local'],
  ['acme/docs/b.md', 'Local'],
  [MISNAMED_RULES_FILE, 'Project'],
]);

describe('whatLoadsAt', () => {
  it('returns a distinguishable unknown for a path the projection never realized', async () => {
    const projection = await claudeContextFixture({ 'CLAUDE.md': 'root\n' });

    expect(whatLoadsAt(projection, 'not/here')).toEqual({
      kind: 'unknown',
      input: 'not/here',
      reason: 'path-not-realized',
    });
  });

  it('throws a coded error — never charges nothing — when a walked blob has no harness facts', async () => {
    const projection = await claudeContextFixture({ 'CLAUDE.md': 'root\n' });
    // The same tables with the facts row gone: a producer that forgot to derive it.
    const underived: Projection = { ...projection, harnessBlobFacts: [] };

    expect(() => whatLoadsAt(underived, '')).toThrow(HarnessFactsAbsentError);
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

  it('charges an ancestor that is ALSO an import target once, by the route the launch walk took first', async () => {
    const answer = await answerAt(
      { 'CLAUDE.md': '@docs/CLAUDE.md\n', [NESTED_CLAUDE_MD]: 'nested\n' },
      'docs',
    );

    // The walk reaches it as the root `CLAUDE.md`'s import before it reaches
    // `docs/`, and one visited set spans the launch: `docs/`'s own step finds
    // it spent (`$q`, docs/external/claude-code-memory-loader.md).
    expect(pathsOf(answer).filter((path) => path === NESTED_CLAUDE_MD)).toEqual([NESTED_CLAUDE_MD]);
    expect(rowAt(answer, NESTED_CLAUDE_MD)?.admissions).toEqual([
      { kind: 'import', rootPath: 'CLAUDE.md', viaPath: 'CLAUDE.md', depth: 1 },
    ]);
    expect(rowAt(answer, NESTED_CLAUDE_MD)?.loadClass).toBe('always');
  });

  it('never re-admits a closure root as an import of itself', async () => {
    const answer = await answerAt(IMPORT_CHAIN, '');

    // The root is in the answer by ANCESTRY and by nothing else: it was seeded
    // into its own traversal rather than reached by a reference, so an `import`
    // admission here would name a hop that never happened.
    expect(rowAt(answer, 'CLAUDE.md')?.admissions).toEqual([{ kind: 'ancestry', dir: '', local: false }]);
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

  it('keeps only the declined links that bear on the queried directory', async () => {
    const projection = await claudeContextFixture({
      'CLAUDE.md': 'root\n',
      'docs/a.md': 'a\n',
      'link/b.md': 'b\n',
    });
    const links = [
      'CLAUDE.local.md', '.claude/CLAUDE.md', '.claude/rules/linked.md', 'docs/linkdir', 'link/CLAUDE.md', 'other/deep/x.md',
      // DIRECTORY links, extensionless: the vendor's shared-rules pattern
      // (`ln -s ~/shared-claude-rules .claude/rules/shared`), and a sibling
      // package's whole `.claude` — the first bears on every query, the second
      // only on queries under `link/`.
      '.claude/rules/shared', 'link/.claude',
      // A NESTED rules link: a path-scoped nested rule is tried root-relative
      // too, so it can load for any directory — kept for every query.
      'pkg/.claude/rules',
    ];
    // ⭐ Half the links are recorded under the OUT-OF-ROOT code. Scoping is
    // about where a link sits, never about where it points, so every code must
    // survive the filter identically — and a filter written on one of them
    // silently deletes the other from every answer.
    const withLinks = links.reduce(
      (current, path, index) => withCondition(
        current,
        symlinkRow(projection, path, index % 2 === 0 ? EXTENT_SYMLINK_NOT_REALIZED : EXTENT_SYMLINK_TARGET_OUTSIDE_ROOT),
      ),
      projection,
    );
    const linkPaths = (path: string): string[] =>
      narrowed(whatLoadsAt(withLinks, path)).conditions
        .filter((row) => isDeclinedSymlinkCode(row.code))
        .map((row) => row.path)
        .sort((left, right) => left.localeCompare(right));

    // An instruction-file link on the chain, anything under a `.claude` on the
    // chain, and any link beneath the queried directory — never a sibling's.
    const rootClaude = ['.claude/CLAUDE.md', '.claude/rules/linked.md', '.claude/rules/shared', 'CLAUDE.local.md'];
    expect(linkPaths('docs')).toEqual([...rootClaude, 'docs/linkdir', 'pkg/.claude/rules']);
    expect(linkPaths('link')).toEqual([...rootClaude, 'link/.claude', 'link/CLAUDE.md', 'pkg/.claude/rules']);
    // The root's subtree is the whole tree.
    expect(linkPaths('')).toEqual([...links].sort((left, right) => left.localeCompare(right)));
  });

  it('escalates a PATH-SHAPED unresolved import to warning and leaves a bare @token at info', async () => {
    // Both tokens are unresolved references out of ONE file, at two distinct
    // lines: `realization_conditions` keys on `(extentId, path, code,
    // resourceId, sourcePath, sourceLine, sourceRef)`, so the two positions record two
    // rows rather than one collapsing the other.
    const answer = await answerAt(
      { 'CLAUDE.md': '@docs/missing.md\n@jeff\n' },
      '',
    );

    expect(answer.conditions.find((c) => c.ref === '@docs/missing.md')?.severity).toBe('warning');
    expect(answer.conditions.find((c) => c.ref === '@jeff')?.severity).toBe('info');
  });

  it('never escalates an escaping import, however path-shaped', async () => {
    const answer = await answerAt({ 'CLAUDE.md': '@~/.claude/shared.md\n' }, '');
    const outside = answer.conditions.filter((c) => c.code === 'CLOSURE_REFERENCE_OUTSIDE_ROOT');

    expect(outside).toHaveLength(1);
    expect(outside[0]?.severity).toBe('info');
    // The token is as path-shaped as they come — an extension and two slashes —
    // so a grader that escalated on shape alone would fire here.
    expect(outside[0]?.ref).toBe('@~/.claude/shared.md');
    // WHY names the loader rule, never a restatement of `message` — the vendor
    // gates an escaping import on external-includes approval, a per-user
    // decision this tree cannot show.
    expect(outside[0]?.why).toMatch(/external includes|hasClaudeMdExternalIncludesApproved/);
    expect(outside[0]?.harness).toBe('claude-code');
    // `subject` is the escaping TARGET — realization_conditions.path, which
    // this code anchors to the target rather than the referrer — distinct from
    // `path` above (the referrer, CLAUDE.md, where an author would look).
    expect(outside[0]?.path).toBe('CLAUDE.md');
    expect(outside[0]?.subject).not.toBeNull();
    expect(outside[0]?.subject).not.toBe(outside[0]?.path);
    expect(outside[0]?.subject?.startsWith('../')).toBe(true);
  });

  it('keeps one finding per REFERRER when two members of one closure import the same target on the same line', async () => {
    // `a.md` and `b.md` sit in the same closure (both imported by CLAUDE.md)
    // and each imports the SAME escaping token on ITS line 1. The STORED row
    // anchors `path` to the escaping target, so the two rows agree on
    // `(extentId, path, code, resourceId, sourceLine, sourceRef)` and differ
    // only in `sourcePath` — a key without it keeps whichever referrer the walk
    // reached first and silently drops the other. The ANSWER's `path` is
    // `sourcePath ?? path` (the file an author opens), which is why the
    // assertion below reads the two referrers, and `subject` the shared target.
    const answer = await answerAt(
      {
        'acme/CLAUDE.md': '@widgets/a.md\n@widgets/b.md\n',
        'acme/widgets/a.md': '@~/.claude/shared.md\n',
        'acme/widgets/b.md': '@~/.claude/shared.md\n',
      },
      'acme',
    );
    const outside = answer.conditions.filter((c) => c.code === 'CLOSURE_REFERENCE_OUTSIDE_ROOT');

    expect(outside.map((c) => c.path).sort((left, right) => left.localeCompare(right)))
      .toEqual(['acme/widgets/a.md', 'acme/widgets/b.md']);
    expect(outside.every((c) => c.line === 1 && c.ref === '@~/.claude/shared.md')).toBe(true);
    // Same subject for both — the rows differ ONLY by their referrer.
    expect(new Set(outside.map((c) => c.subject)).size).toBe(1);
  });

  it('reports the import chain and the loader-rule WHY for an unresolved import, graded by shape', async () => {
    // The vendor-observation fixture (docs/external/claude-code-memory-loader.md):
    // a wiki page importing a doctor that names no file. Both tokens live in
    // `wiki/doctors.md`, one hop off the entry point — two distinct positions
    // in the same file, which the widened `realization_conditions` key now
    // keeps as two separate findings.
    const answer = await answerAt(
      {
        'acme/CLAUDE.md': '@wiki/doctors.md\n',
        'acme/wiki/doctors.md': '@doogie.howser.md\n@docs/missing.md\n',
      },
      'acme',
    );

    // EXACTLY two: fewer is a finding lost to a narrow key, more is one
    // duplicated by the fixpoint's re-emission.
    const unresolved = answer.conditions.filter(
      (c) => c.code === 'CLOSURE_REFERENCE_UNRESOLVED' && c.path === 'acme/wiki/doctors.md',
    );
    expect(unresolved).toHaveLength(2);

    const bare = unresolved.find((c) => c.ref === '@doogie.howser.md');
    const pathShaped = unresolved.find((c) => c.ref === '@docs/missing.md');
    if (bare === undefined || pathShaped === undefined) throw new Error('fixture did not land both conditions');

    expect(bare.code).toBe('CLOSURE_REFERENCE_UNRESOLVED');
    expect(bare.severity).toBe('info');
    expect(pathShaped.severity).toBe('warning');

    for (const condition of [bare, pathShaped]) {
      // WHAT — the file an author opens, and the token, by name and line.
      expect(condition.path).toBe('acme/wiki/doctors.md');
      expect(condition.line).toBe(condition.ref === '@doogie.howser.md' ? 1 : 2);
      expect(condition.message).toContain(condition.ref);
      expect(condition.subject).toBeNull();
      // WHY — the harness's own loader rule, not a copy of `message`.
      expect(condition.harness).toBe('claude-code');
      expect(condition.why).toMatch(/absent|silently skipped/);
      expect(condition.why).not.toBe(condition.message);
      // WHAT IT AFFECTS — the chain from the entry point through the one hop
      // that holds the reference.
      expect(condition.affects).toEqual({ chain: ['acme/CLAUDE.md', 'acme/wiki/doctors.md'], hop: 1 });
    }
  });

  it('never demotes a STORED warning, however bare the shape', async () => {
    // §9.1 escalates; it must never do the opposite. A bare `@jeff` graded on
    // shape alone computes `info` — the control that proves the surviving
    // `warning` came from the STORED severity, not from a grader that quietly
    // agrees with whatever it is given. The fixture's own content names no `@`
    // token at all, so the only `@jeff` condition in the answer is the one this
    // test injects — a real, naturally-produced `@jeff` row would also grade
    // `info` and be indistinguishable from a demoted `warning`.
    const projection = await claudeContextFixture({ 'CLAUDE.md': 'root, no imports here\n' });
    const realization = projection.resourceRealizations.find((row) => row.path === 'CLAUDE.md');
    if (realization === undefined) throw new Error('fixture is missing its CLAUDE.md');
    const storedWarning: RealizationConditionRow = {
      extentId: realization.extentId,
      path: 'CLAUDE.md',
      code: 'CLOSURE_REFERENCE_UNRESOLVED',
      severity: 'warning',
      message: 'a bare unresolved import, stored at warning by this test\'s own doing',
      resourceId: realization.resourceId,
      sourcePath: 'CLAUDE.md',
      sourceLine: 1,
      sourceRef: '@jeff',
      targetExists: null,
      matchedPattern: null,
      matchedPayload: null,
    };
    const answer = narrowed(whatLoadsAt(withCondition(projection, storedWarning), ''));

    expect(answer.conditions.find((c) => c.ref === '@jeff')?.severity).toBe('warning');
  });

  it('affects is null for a base-extent condition — no import closure to attribute a chain from', async () => {
    const projection = await claudeContextFixture({ 'CLAUDE.md': 'root\n' });
    const answer = narrowed(whatLoadsAt(withCondition(projection, rootAbsentRow(projection)), ''));
    const condition = answer.conditions.find((c) => c.code === 'CLOSURE_ROOT_ABSENT');

    expect(condition?.affects).toBeNull();
    expect(condition?.harness).toBe('claude-code');
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

  it('classes an unscoped rule ALWAYS in every directory on the walk, nested or root', async () => {
    // The launch walk reads `.claude/rules` in every directory from the root
    // down to the working directory (`$yn`, docs/external/claude-code-memory-loader.md).
    const nested = await answerAt({ [NESTED_RULE]: 'nested rule\n' }, 'sub');
    const root = await answerAt({ '.claude/rules/y.md': 'root rule\n' }, '');

    expect(rowAt(nested, NESTED_RULE)?.loadClass).toBe('always');
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

  it('keeps a path-scoped rule OUT of the always-loaded budget, but not its unscoped import', async () => {
    const answer = await answerAt(SCOPED_RULE_TREE, SCOPED_RULE_SUBJECT);
    const always = answer.rows.filter((row) => row.loadClass === 'always').map((row) => row.path);

    // The launch walk reads the rule, then filters its closure entry by entry on
    // each file's OWN `paths:` (`Lke`): the rule is dropped, its unscoped import
    // loads. `CLAUDE.md` is the control a query classing nothing `always` fails.
    expect(always).toEqual([ROOT_CLAUDE_MD, SCOPED_RULE_HELPER]);
    expect(rowAt(answer, SCOPED_RULE_HELPER)?.admissions).toEqual([
      { kind: 'import', rootPath: SCOPED_RULE, viaPath: SCOPED_RULE, depth: 1 },
    ]);
  });

  it('lets `always` win over `on-demand` when one identity carries both', async () => {
    // The path-scoped rule is loaded at launch as the root `CLAUDE.md`'s import
    // (nothing filters a `CLAUDE.md` closure) AND admitted on demand by its glob.
    // Reporting the weaker class would under-report a file loaded at launch.
    const answer = await answerAt(
      { ...SCOPED_RULE_TREE, [ROOT_CLAUDE_MD]: `@${SCOPED_RULE}\n` },
      SCOPED_RULE_SUBJECT,
    );
    const row = rowAt(answer, SCOPED_RULE);

    expect(row?.admissions.map((a) => a.kind).sort()).toEqual(['glob-rule', 'import']);
    expect(row?.loadClass).toBe('always');
  });

  it('reports a member it cannot attribute, and never charges it on the membership table\'s word', async () => {
    const projection = await withStrayMembership({
      'CLAUDE.md': '@docs/handbook.md\n',
      'docs/handbook.md': 'x\n',
    });
    const answer = narrowed(whatLoadsAt(projection, ''));

    // The launch walk follows the import edges, and no edge reaches the stray:
    // it is named as unexplained rather than charged under an invented parent.
    expect(answer.rows.find((row) => row.path === STRAY)).toBeUndefined();
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

  it('never loads a path-scoped rule\'s import on demand — it loaded at launch or not at all', async () => {
    const answer = await answerAt(
      { ...SCOPED_RULE_TREE, [SCOPED_RULE_HELPER]: "---\npaths: ['docs/**']\n---\nhelper\n" },
      SCOPED_RULE_SUBJECT,
    );

    // The helper declares `paths:` of its own, so the launch walk drops it, and
    // the read of `src/a.ts` keeps only entries whose OWN globs match it (`y3`).
    expect(rowAt(answer, SCOPED_RULE)?.loadClass).toBe('on-demand');
    expect(rowAt(answer, SCOPED_RULE_HELPER)).toBeUndefined();
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

  it('exposes the refused target as `subject` for CLOSURE_DEPTH_EXCEEDED, citing the loader\'s depth bound', async () => {
    // The ROOT closure's own walk overruns its 4-hop budget one hop into
    // `NESTED_RULE`'s `@helper.md` — `NESTED_RULE_HELPER` loads anyway (the
    // PREVIOUS test), but only via `NESTED_RULE`'s own closure; the ROOT
    // closure's walk records the refusal, anchored to the REFERRER
    // (`NESTED_RULE`, whose reference overran the budget).
    const answer = await answerAt(DEPTH_CAPPED_CHAIN, 'sub');
    const depthExceeded = answer.conditions.find((c) => c.code === 'CLOSURE_DEPTH_EXCEEDED');
    if (depthExceeded === undefined) throw new Error('fixture did not land a CLOSURE_DEPTH_EXCEEDED condition');

    expect(depthExceeded.path).toBe(NESTED_RULE);
    // `subject` is the refused TARGET — what `path` alone would otherwise drop.
    expect(depthExceeded.subject).toBe(NESTED_RULE_HELPER);
    expect(depthExceeded.harness).toBe('claude-code');
    expect(depthExceeded.why).toMatch(/Pyn|oQe/);
  });

  it('keeps the provenance map a SUBSET of the extent membership it labels', async () => {
    const projection = await claudeContextFixture({ ...DIAMOND, 'unreferenced.md': 'y\n' });
    const provenanceRow = projection.zoneProvenance[0];
    if (provenanceRow === undefined) throw new Error('fixture produced no import extent');

    const members = memberPathsOf(projection, provenanceRow.contextId);
    const provenance = closureProvenance({
      root: projection.roots[0]?.path ?? '',
      resourceRealizations: projection.resourceRealizations,
      blobs: projection.blobs,
      blobReferences: projection.blobReferences,
      harnessBlobFacts: projection.harnessBlobFacts,
      harnessBlobImports: projection.harnessBlobImports,
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

  describe('headerTokens — the render header Claude Code prints before each file', () => {
    it('charges the launch header, kind Project or Local by the row\'s own chain root — never by a filename alone', async () => {
      const answer = await answerAt(HEADER_TREE, 'acme');

      for (const [path, kind] of HEADER_TREE_KIND) {
        const row = rowAt(answer, path);
        expect(row?.loadClass, path).toBe('always');
        expect(row?.headerTokens, path).toBe(
          estimateTokens(CLAUDE_CODE.renderHeader(safePath.join(CLAUDE_CONTEXT_FIXTURE_ROOT, path), kind, 'launch')),
        );
      }
    });

    it('charges the launch preamble once, and adds it and every header into alwaysTokens', async () => {
      const answer = await answerAt(HEADER_TREE, 'acme');
      const accounted = account(answer);

      expect(accounted.totals.preambleTokens).toBe(estimateTokens(CLAUDE_CODE.launchPreamble));
      const headerSum = accounted.rows.reduce((total, row) => total + row.headerTokens, 0);
      expect(accounted.totals.headerTokens).toBe(headerSum);
      const alwaysSum = accounted.rows
        .filter((row) => row.loadClass === 'always')
        .reduce((total, row) => total + (row.tokens ?? 0) + row.headerTokens, 0);
      expect(accounted.totals.alwaysTokens).toBe(accounted.totals.preambleTokens + alwaysSum);
    });

    it('charges NO preamble for a launch that loads nothing', async () => {
      const answer = await answerAt({ 'src/index.ts': 'x\n' }, 'src');
      const accounted = account(answer);

      expect(accounted.rows).toEqual([]);
      expect(accounted.totals.preambleTokens).toBe(0);
      expect(accounted.totals.alwaysTokens).toBe(0);
    });

    it('charges the ON-READ header — no kind suffix — for a file loaded by reading it', async () => {
      const answer = await answerAt(SCOPED_RULE_TREE, SCOPED_RULE_SUBJECT);
      const row = rowAt(answer, SCOPED_RULE);

      expect(row?.loadClass).toBe('on-demand');
      expect(row?.headerTokens).toBe(
        estimateTokens(
          CLAUDE_CODE.renderHeader(safePath.join(CLAUDE_CONTEXT_FIXTURE_ROOT, SCOPED_RULE), 'Project', 'read'),
        ),
      );
    });
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
 * A declined-link row at `path`, in the base extent — what the filesystem
 * extent emits for a symlink it met and did not realize.
 *
 * @param projection - The fixture projection, for its base extent id
 * @param path - Root-relative link path
 * @returns The row
 */
function symlinkRow(
  projection: Projection,
  path: string,
  code: string = EXTENT_SYMLINK_NOT_REALIZED,
): RealizationConditionRow {
  const extentId = projection.resourceRealizations[0]?.extentId;
  if (extentId === undefined) throw new Error('fixture realized nothing');
  return {
    extentId,
    path,
    code,
    severity: 'info',
    message: 'a declined link',
    resourceId: null,
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
