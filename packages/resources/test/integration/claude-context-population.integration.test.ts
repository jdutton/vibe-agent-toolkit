/* eslint-disable security/detect-non-literal-fs-filename -- every path below is joined from this suite's own mkdtemp root */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOADING_TAG } from '../../src/projection/agentic-tags.js';
import { buildClaudeContextPopulation } from '../../src/projection/claude-context-population.js';
import { CLAUDE_IMPORT_KIND } from '../../src/projection/contributors/claude-import-extent.js';
import { RULE_SCOPE_TAG } from '../../src/projection/contributors/claude-rules-scope.js';
import type { Projection } from '../../src/projection/projection.js';

/**
 * A real on-disk tree, because this test is about WIRING: that root discovery
 * runs before `populate`, that the registry accepts one contributor per root,
 * that the blob stage actually runs, and that the two classifiers see each
 * other's rows. The behaviour those contributors implement is unit-tested
 * against hand-built bases; only the assembly needs a filesystem.
 */
let suiteDir: string;
let projection: Projection;

/** The one hop-2 import chain, so the lane is proven to walk past depth 1. */
const HANDBOOK = 'docs/handbook.md';

beforeAll(async () => {
  // `normalizedTmpdir`, not `os.tmpdir()`: on Windows the raw value can be an
  // 8.3 short name (`RUNNER~1`), which does not compare equal to the long path
  // every realization row is stated against.
  suiteDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-claude-context-'));
  await mkdir(safePath.join(suiteDir, 'docs'), { recursive: true });
  await mkdir(safePath.join(suiteDir, '.claude/rules'), { recursive: true });
  await mkdir(safePath.join(suiteDir, 'packages/cli/.claude/rules'), { recursive: true });

  await writeFile(safePath.join(suiteDir, 'CLAUDE.md'), `# Root\n\n@${HANDBOOK}\n`);
  await writeFile(safePath.join(suiteDir, HANDBOOK), '# Handbook\n\n@deeper.md\n');
  await writeFile(safePath.join(suiteDir, 'docs/deeper.md'), '# Deeper\n');
  await writeFile(safePath.join(suiteDir, 'docs/CLAUDE.md'), '# Docs\n\n@missing.md\n');
  await writeFile(
    safePath.join(suiteDir, '.claude/rules/always.md'),
    '---\ndescription: always on\n---\n\nAlways.\n',
  );
  await writeFile(
    safePath.join(suiteDir, '.claude/rules/typescript.md'),
    '---\npaths: ["**/*.ts"]\n---\n\nTS only.\n',
  );
  await writeFile(
    safePath.join(suiteDir, 'packages/cli/.claude/rules/local.md'),
    '---\ndescription: nested\n---\n\nNested.\n',
  );

  projection = await buildClaudeContextPopulation({
    root: suiteDir,
    onBlobPopulation: () => undefined,
  });
}, 60_000);

afterAll(async () => {
  // Generous, and deliberately so: a recursive `rm` over a temp tree has timed
  // out at Vitest's 10s hook default on Windows CI, which fails the whole file
  // for a reason that has nothing to do with what it tests.
  await rm(suiteDir, { recursive: true, force: true });
}, 60_000);

/** The extent id of one root's import closure, read back off provenance. */
function extentFor(rootRelativePath: string): string {
  const row = projection.zoneProvenance
    .find((provenance) => provenance.contributorId.endsWith(`:${rootRelativePath}`));
  if (row === undefined) throw new Error(`No import extent registered for ${rootRelativePath}`);
  return row.contextId;
}

/**
 * The root-relative paths one extent realizes, in a stable order.
 *
 * Sorted by code point rather than `localeCompare`: the assertion is about which
 * files are members, and a locale-dependent order would make the expectation
 * machine-dependent for no benefit.
 */
function membersOf(extentId: string): string[] {
  return projection.resourceRealizations
    .filter((row) => row.extentId === extentId)
    .map((row) => row.path)
    .sort(byCodePoint);
}

/**
 * Order two paths by UTF-16 code point.
 *
 * Deliberately not `String.localeCompare`, which `sonarjs` suggests by default:
 * it is ICU- and locale-dependent, and an expectation that changes with the
 * machine's locale is not an expectation.
 */
function byCodePoint(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

describe('buildClaudeContextPopulation', () => {
  it('registers one claude-import extent per discovered root', () => {
    // Two CLAUDE.md plus three rules files. A count rather than a set, because
    // the point is that root DISCOVERY ran before `populate` and registered a
    // contributor apiece — the ordering constraint the whole lane is shaped by.
    expect(projection.resolutionContexts.filter((row) => row.kind === CLAUDE_IMPORT_KIND))
      .toHaveLength(5);
  });

  it('walks a real two-hop import chain out of the root CLAUDE.md', () => {
    // This is the assertion this repo's own corpus cannot make: it holds exactly
    // two import edges and both are at depth 1, so it cannot distinguish a
    // correct four-hop traversal from a one-hop one.
    expect(membersOf(extentFor('CLAUDE.md')))
      .toEqual(['CLAUDE.md', 'docs/deeper.md', HANDBOOK]);
  });

  it('reports a dangling import as a condition instead of dropping it silently', () => {
    // `docs/CLAUDE.md` imports `@missing.md`. Before the dialect landed, EVERY
    // import in every corpus looked exactly like this row — which is why the
    // defect was invisible.
    const dangling = projection.realizationConditions
      .filter((row) => row.code === 'CLOSURE_REFERENCE_UNRESOLVED');
    expect(dangling).toHaveLength(1);
    expect(dangling[0]?.sourceRef).toBe('@missing.md');
  });

  it('tags all three rules files with their scope', () => {
    const scopeByPath = new Map(
      projection.resourceTags
        .filter((row) => row.tag === RULE_SCOPE_TAG)
        .map((row) => [
          projection.resourceRealizations.find((r) => r.resourceId === row.resourceId)?.path,
          row.value,
        ] as const),
    );

    expect(scopeByPath.get('.claude/rules/always.md')).toBe('root');
    expect(scopeByPath.get('.claude/rules/typescript.md')).toBe('path-scoped');
    expect(scopeByPath.get('packages/cli/.claude/rules/local.md')).toBe('nested');
  });

  it('leaves exactly one loading producer — no rules file carries a loading row', () => {
    // The cross-producer invariant, asserted where BOTH classifiers actually run
    // together. `resource_tags` keys on (resourceId, tag, value, source) with
    // `value` in the key, so two producers could file contradictory loading rows
    // for one identity without colliding — and only a run with both registered
    // can show that they do not.
    const ruleIds = new Set(
      projection.resourceTags
        .filter((row) => row.tag === RULE_SCOPE_TAG)
        .map((row) => row.resourceId),
    );

    expect(projection.resourceTags
      .filter((row) => row.tag === LOADING_TAG && ruleIds.has(row.resourceId)))
      .toEqual([]);
  });

  it('still tags CLAUDE.md loading:always through the convention classifier', () => {
    // The control for the test above: `loading` rows are absent for RULES files
    // specifically, not absent because the convention classifier failed to run.
    const claudeMd = projection.resourceRealizations.find((row) => row.path === 'CLAUDE.md');
    expect(projection.resourceTags.find(
      (row) => row.resourceId === claudeMd?.resourceId && row.tag === LOADING_TAG,
    )?.value).toBe('always');
  });
});
