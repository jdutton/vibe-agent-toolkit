/**
 * The LAZY harness pass: Claude Code's memory facts are derived only for the
 * blobs its loader can reach — every entry point, followed through its own
 * imports for four hops — plus every member of a declared `claude-import`
 * extent, and for nothing else.
 */

import { compareCodeUnits, readWorkCounters, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { computeContentKey, keyContent, type ContentKey } from '../src/content-key.js';
import { ParseLimitError, ParseWorkerDiedError } from '../src/parse-limits.js';
import { BLOB_PARSE_LIMIT_EXCEEDED, BLOB_PARSE_WORKER_DIED } from '../src/projection/blob-condition-codes.js';
import { harnessRowsFor } from '../src/projection/blob-facts.js';
import { describeBlobRefusals, notAdmittedRealizations } from '../src/projection/blob-refusals.js';
import { NO_GIT_MEMBERS, RunContentCache } from '../src/projection/content-cache.js';
import { extentContextId } from '../src/projection/contributors/context-id.js';
import { CLAUDE_CODE, CLAUDE_OVERSIZE_BYTES } from '../src/projection/harness/claude-code.js';
import { runHarnessPass, storedHarnessRows, type HarnessFactsDeriver } from '../src/projection/harness/harness-pass.js';
import { harnessFrontier } from '../src/projection/harness/reach.js';
import { ProjectionBuilder } from '../src/projection/projection.js';
import type { RunContentSource } from '../src/projection/run-population.js';
import { emptyBlobRows } from '../src/projection/store-hydration.js';
import type { HarnessPair } from '../src/projection/store.js';
import { ExtentDeclarationSchema, type ReferenceDialect } from '../src/schemas/project-config.js';
import type { JsonValue } from '../src/schemas/projection-shared.js';

import { addFile, contentSourceOver, IN_PROCESS_HARNESS_FACTS, NO_STORED_HARNESS_ROWS } from './helpers/claude-context-fixture.js';

/**
 * Resolved, so it is absolute on every platform: a bare `/vat-corpus/…` has no
 * drive letter on Windows, and the not-admitted adapter resolves the paths it
 * reports, so a `${ROOT}/…` expectation built from the literal missed the drive.
 */
const ROOT = safePath.resolve('/vat-corpus/acme-harness-pass');

/** A deriver that is a spy over the shipped reader, run in-process. */
function spiedDeriver(): HarnessFactsDeriver & ReturnType<typeof vi.fn> {
  return vi.fn(IN_PROCESS_HARNESS_FACTS) as HarnessFactsDeriver & ReturnType<typeof vi.fn>;
}

/** A spied deriver that refuses `refused` with `error`, and reads every other file in-process. */
function refusing(refused: string, error: Error): HarnessFactsDeriver & ReturnType<typeof vi.fn> {
  return vi.fn((harness: Parameters<HarnessFactsDeriver>[0], input: Parameters<HarnessFactsDeriver>[1]) =>
    input.content === refused ? Promise.reject(error) : IN_PROCESS_HARNESS_FACTS(harness, input)) as HarnessFactsDeriver & ReturnType<typeof vi.fn>;
}

/** A content source over the fixture's own file map — never the disk. */
function readerOver(files: Readonly<Record<string, string>>): RunContentSource {
  return contentSourceOver(ROOT, files);
}

/** A builder holding the files — realizations, blobs, NO harness facts. */
function builderFor(files: Readonly<Record<string, string>>, deferred: readonly string[] = []): ProjectionBuilder {
  const builder = new ProjectionBuilder({ root: ROOT, contentCache: new RunContentCache(NO_GIT_MEMBERS) });
  builder.addRoot({ id: builder.identities.rootId, path: ROOT });
  for (const [path, markdown] of Object.entries(files)) {
    addFile(builder, { path, refs: [], markdown, deferred: deferred.includes(path) }, ROOT);
  }
  return builder;
}

/** The content key a fixture file's bytes are filed under. */
function keyOf(markdown: string): ContentKey {
  return computeContentKey(Buffer.from(markdown, 'utf-8'), 'markdown');
}

/** The paths (of `files`) whose blob has a facts row. */
function derivedPaths(builder: ProjectionBuilder, files: Readonly<Record<string, string>>): string[] {
  const derived = new Set(builder.base().harnessBlobFacts.map((row) => row.blob));
  return Object.entries(files)
    .filter(([, markdown]) => derived.has(keyOf(markdown)))
    .map(([path]) => path)
    .sort(compareCodeUnits);
}

const DOCS = 'docs/';

/**
 * A chain `head → docs/<prefix>1 → … → docs/<prefix><length>`, each import
 * spelled relative to its importer, and each file naming itself so no two
 * share bytes.
 */
function chain(head: string, prefix: string, length: number): Record<string, string> {
  const paths = [head, ...Array.from({ length }, (_, index) => `${DOCS}${prefix}${index + 1}.md`)];
  const files: Record<string, string> = {};
  for (const [index, path] of paths.entries()) {
    const next = paths[index + 1];
    const ref = next === undefined || !toForwardSlash(path).startsWith(DOCS) ? next : next.slice(DOCS.length);
    files[path] = ref === undefined ? `# ${path} — the end of the acme chain\n` : `# ${path}\n\n@${ref}\n`;
  }
  return files;
}

/**
 * Plant a claude-import-dialect extent by hand — its context, its provenance
 * row and one member realization — as the closure contributor would leave it.
 */
function plantExtent(
  builder: ProjectionBuilder,
  options: { closureFrom: string; maxDepth: number | 'full'; dialect: ReferenceDialect; members: readonly string[] },
): void {
  const contextId = extentContextId('claude-import', builder.identities.rootId, options.closureFrom);
  builder.addContext({ contextId, species: 'extent', kind: 'claude-import', rootId: builder.identities.rootId, extentContextId: null, role: null });
  const declaration = ExtentDeclarationSchema.parse({
    kind: 'claude-import',
    closureFrom: options.closureFrom,
    follow: [],
    referenceDialect: options.dialect,
    maxDepth: options.maxDepth,
    refusals: [],
    admitPaths: [],
  });
  builder.addProvenance({
    contextId,
    contributorId: `acme:${options.closureFrom}`,
    parameterSet: declaration as unknown as JsonValue,
    extentDigest: 'acme',
  });
  for (const member of options.members) {
    const row = builder.base().resourceRealizations.find((candidate) => candidate.path === member);
    if (row === undefined) throw new Error(`fixture: ${member} is not realized`);
    builder.addRealization({ ...row, extentId: contextId });
    builder.addExtentMembership({ resourceId: row.resourceId, extentId: contextId });
  }
}

/** One pass over a fresh builder of `files`, with a spied deriver. */
async function passOver(files: Readonly<Record<string, string>>): Promise<{
  derived: string[];
  factsOfCalls: number;
  result: Awaited<ReturnType<typeof runHarnessPass>>;
}> {
  const builder = builderFor(files);
  const derive = spiedDeriver();
  const result = await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), derive, NO_STORED_HARNESS_ROWS);
  return { derived: derivedPaths(builder, files), factsOfCalls: derive.mock.calls.length, result };
}

describe('runHarnessPass', () => {
  it('derives facts only for what the loader reaches', async () => {
    const files = {
      'CLAUDE.md': '# acme\n\n@docs/a.md\n',
      'docs/a.md': '# a\n\n@b.md\n',
      'docs/b.md': '# b — widgets\n',
      'src/index.ts': '/** @param x */\nexport const widgets = 1;\n',
      'README.md': '# readme\n\n@docs/c.md\n',
      'docs/c.md': '# c — never loaded\n',
    };
    const { derived, factsOfCalls, result } = await passOver(files);

    expect(derived).toEqual(['CLAUDE.md', 'docs/a.md', 'docs/b.md']);
    expect(factsOfCalls).toBe(3);
    expect(result).toEqual({ derived: 3, served: [], refused: 0, unreadable: 0, unreadableKeys: new Set() });
  });

  it('stops at four hops', async () => {
    const files = chain('CLAUDE.md', 'c', 5);
    const builder = builderFor(files);

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS, NO_STORED_HARNESS_ROWS);

    expect(derivedPaths(builder, files)).toEqual(['CLAUDE.md', 'docs/c1.md', 'docs/c2.md', 'docs/c3.md', 'docs/c4.md']);
  });

  it('terminates on a cycle and lexes each blob once', async () => {
    const files = {
      'CLAUDE.md': '# acme\n\n@a.md\n',
      'a.md': '# a\n\n@b.md\n',
      'b.md': '# b\n\n@a.md\n',
    };
    const { derived, factsOfCalls } = await passOver(files);

    expect(derived).toEqual(['CLAUDE.md', 'a.md', 'b.md']);
    expect(factsOfCalls).toBe(3);
  });

  it('lexes a diamond\'s shared target once', async () => {
    const files = {
      'CLAUDE.md': '# acme\n\n@a.md @b.md\n',
      'a.md': '# a\n\n@d.md\n',
      'b.md': '# b\n\n@d.md\n',
      'd.md': '# d — widgets\n',
    };
    const { derived, factsOfCalls } = await passOver(files);

    expect(derived).toEqual(['CLAUDE.md', 'a.md', 'b.md', 'd.md']);
    expect(factsOfCalls).toBe(4);
  });

  it('follows no import of a file that injects nothing', async () => {
    const files = {
      'CLAUDE.md': '---\npaths: x\n---\n<!-- @a.md -->\n',
      'a.md': '# a — hidden in a comment\n',
    };
    const builder = builderFor(files);

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS, NO_STORED_HARNESS_ROWS);

    expect(builder.base().harnessBlobFacts.map((row) => row.injectedBytes)).toEqual([0]);
    expect(derivedPaths(builder, files)).toEqual(['CLAUDE.md']);
  });

  it('follows no import of a file that injects nothing, even when its facts list one', async () => {
    // The comment-only body above yields no import row at all, so the guard it
    // names could be deleted and that test would stay green. This one plants a
    // zero-injection facts row that DOES list an import — the only shape that
    // proves the pass reads `injectedBytes` before following anything.
    const files = { 'CLAUDE.md': '# acme\n', 'a.md': '# a\n' };
    const builder = builderFor(files);
    builder.addHarnessBlobImport({ blob: keyOf(files['CLAUDE.md']), harness: 'claude-code', ordinal: 0, rawRef: '@a.md', target: 'a.md', line: 1 });
    builder.addHarnessBlobFacts({ blob: keyOf(files['CLAUDE.md']), harness: 'claude-code', injectedBytes: 0, injectedTokens: 0, paths: null });

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS, NO_STORED_HARNESS_ROWS);

    expect(derivedPaths(builder, files)).toEqual(['CLAUDE.md']);
  });

  it('skips a non-Syn target but derives an oversize one', async () => {
    const files = {
      'CLAUDE.md': '# acme\n\n@x.pierce @big.md\n',
      'x.pierce': '# not text to the harness\n',
      'big.md': '# big — pretend it is past the cliff\n\n@after.md\n',
      'after.md': '# after — behind the oversize file\n',
    };
    const realBlob = builderFor(files).base().blobs.find((row) => row.contentKey === keyOf(files['big.md']));
    if (realBlob === undefined) throw new Error('fixture: big.md has no blob row');
    const builder = new ProjectionBuilder({ root: ROOT, contentCache: new RunContentCache(NO_GIT_MEMBERS) });
    builder.addRoot({ id: builder.identities.rootId, path: ROOT });
    // Planted FIRST so `addFile`'s own blob row for these bytes is the duplicate:
    // the cliff is about `blobs.bytes`, and 4 MiB of real text would cost the
    // parser most of a second to say nothing new.
    builder.addBlob({ ...realBlob, bytes: CLAUDE_OVERSIZE_BYTES + 1 });
    for (const [path, markdown] of Object.entries(files)) addFile(builder, { path, refs: [], markdown }, ROOT);
    expect(builder.base().blobs.find((row) => row.contentKey === keyOf(files['big.md']))?.bytes).toBe(CLAUDE_OVERSIZE_BYTES + 1);

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS, NO_STORED_HARNESS_ROWS);

    expect(derivedPaths(builder, files)).toEqual(['CLAUDE.md', 'after.md', 'big.md']);
  });

  it('shares facts by content', async () => {
    const shared = '# shared acme widgets\n';
    const files = {
      'CLAUDE.md': '# acme\n\n@docs/a.md\n',
      'docs/a.md': shared,
      'other/a.md': shared,
    };
    const builder = builderFor(files);
    const derive = spiedDeriver();

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), derive, NO_STORED_HARNESS_ROWS);

    expect(builder.base().harnessBlobFacts.filter((row) => row.blob === keyOf(shared))).toHaveLength(1);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('skips an unkeyed realization', async () => {
    const files = { 'CLAUDE.md': '# acme\n\n@a.md\n', 'a.md': '# a\n' };
    const builder = builderFor(files, ['CLAUDE.md']);

    const result = await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS, NO_STORED_HARNESS_ROWS);

    expect(result.derived).toBe(0);
    expect(builder.base().harnessBlobFacts).toEqual([]);
  });

  it('reads a rule file and a nested CLAUDE.local.md as entry points', async () => {
    const files = {
      '.claude/rules/r.md': '# rule\n',
      'acme/CLAUDE.local.md': '# local\n',
      'acme/widgets/.claude/CLAUDE.md': '# nested project file\n',
      'acme/notes.md': '# not an entry point\n',
    };
    const builder = builderFor(files);

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS, NO_STORED_HARNESS_ROWS);

    expect(derivedPaths(builder, files)).toEqual(['.claude/rules/r.md', 'acme/CLAUDE.local.md', 'acme/widgets/.claude/CLAUDE.md']);
  });

  it('covers members of a declared claude-import extent beyond four hops', async () => {
    const files = chain('CLAUDE.md', 'c', 6);
    const builder = builderFor(files);
    plantExtent(builder, { closureFrom: 'CLAUDE.md', maxDepth: 4, dialect: 'claude-import', members: ['docs/c6.md'] });

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS, NO_STORED_HARNESS_ROWS);

    expect(derivedPaths(builder, files)).toEqual(
      ['CLAUDE.md', 'docs/c1.md', 'docs/c2.md', 'docs/c3.md', 'docs/c4.md', 'docs/c6.md'],
    );
  });

  it('follows a declared claude-import closure to its own depth from its own root', async () => {
    // Not an entry point, and six hops deep: only the declaration's `maxDepth`
    // reaches the end, so the closure's fixpoint does not have to discover it
    // one iteration per hop.
    const files = chain('docs/start.md', 'd', 6);
    const builder = builderFor(files);
    plantExtent(builder, { closureFrom: 'docs/start.md', maxDepth: 'full', dialect: 'claude-import', members: [] });

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS, NO_STORED_HARNESS_ROWS);

    expect(derivedPaths(builder, files)).toEqual(Object.keys(files).sort(compareCodeUnits));
  });

  it('reads the dialect off the declaration, so an href extent is not the harness\'s', async () => {
    const files = chain('docs/start.md', 'd', 2);
    const builder = builderFor(files);
    plantExtent(builder, { closureFrom: 'docs/start.md', maxDepth: 'full', dialect: 'href', members: ['docs/d2.md'] });

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS, NO_STORED_HARNESS_ROWS);

    expect(builder.base().harnessBlobFacts).toEqual([]);
  });

  it('refuses a projection with more than one root rather than resolving against the first', () => {
    const builder = builderFor({ 'CLAUDE.md': '# acme\n' });
    builder.addRoot({ id: 'root-widgets', path: '/vat-corpus/widgets' });

    expect(() => harnessFrontier(builder.base(), CLAUDE_CODE)).toThrow(/2 roots/);
  });

  it('parses each provenance row\'s declaration once across frontier calls, and a replaced row again', () => {
    const files = chain('docs/start.md', 'd', 2);
    const builder = builderFor(files);
    plantExtent(builder, { closureFrom: 'docs/start.md', maxDepth: 'full', dialect: 'claude-import', members: [] });
    const parse = vi.spyOn(ExtentDeclarationSchema, 'safeParse');
    try {
      const first = harnessFrontier(builder.base(), CLAUDE_CODE);
      expect(parse).toHaveBeenCalledTimes(1);

      expect(harnessFrontier(builder.base(), CLAUDE_CODE)).toEqual(first);
      expect(parse).toHaveBeenCalledTimes(1);

      // The provenance table replaces a contributor's row in place as its
      // fixpoint re-runs: the new row object is a miss, never a stale hit.
      plantExtent(builder, { closureFrom: 'docs/start.md', maxDepth: 1, dialect: 'claude-import', members: [] });
      parse.mockClear();
      harnessFrontier(builder.base(), CLAUDE_CODE);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('refuses a projection with realizations and no root', () => {
    const builder = new ProjectionBuilder({ root: ROOT, contentCache: new RunContentCache(NO_GIT_MEMBERS) });
    addFile(builder, { path: 'CLAUDE.md', refs: [], markdown: '# acme\n' }, ROOT);

    expect(() => harnessFrontier(builder.base(), CLAUDE_CODE)).toThrow(/no root/);
  });

  it('returns 0 on a settled projection', async () => {
    const files = { 'CLAUDE.md': '# acme\n\n@a.md\n', 'a.md': '# a\n' };
    const builder = builderFor(files);
    const derive = spiedDeriver();
    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), derive, NO_STORED_HARNESS_ROWS);
    derive.mockClear();

    const second = await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), derive, NO_STORED_HARNESS_ROWS);

    expect(second.derived).toBe(0);
    expect(derive).not.toHaveBeenCalled();
    expect(harnessFrontier(builder.base(), CLAUDE_CODE)).toEqual([]);
  });

  it('counts a reader that returns null as unreadable and does not loop', async () => {
    const files = {
      'CLAUDE.md': '# acme\n\n@docs/a.md\n',
      'docs/a.md': '# a\n\n@b.md\n',
      'docs/b.md': '# b\n',
    };
    const builder = builderFor(files);
    const source = readerOver(files);
    const reader: RunContentSource = {
      read: (entry) => (entry.absolutePath === safePath.join(ROOT, 'docs/a.md') ? Promise.resolve(null) : source.read(entry)),
    };

    const result = await runHarnessPass(builder, [CLAUDE_CODE], reader, IN_PROCESS_HARNESS_FACTS, NO_STORED_HARNESS_ROWS);

    expect(result.unreadable).toBe(1);
    expect(result.unreadableKeys).toEqual(new Set([keyOf(files['docs/a.md'])]));
    expect(derivedPaths(builder, files)).toEqual(['CLAUDE.md']);
  });

  it('refuses with HARNESS_FACTS_ABSENT, never loops, when a derived blob stays on the frontier', async () => {
    const files = { 'CLAUDE.md': '# acme\n\n@a.md\n', 'a.md': '# a\n' };
    const builder = builderFor(files);
    // A pass that files neither a facts row nor a condition row for what it
    // derived — the shape that re-demanded the same key forever (ADR I8).
    vi.spyOn(builder, 'addHarnessBlobFacts').mockImplementation(() => false);
    const derive = spiedDeriver();

    await expect(runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), derive, NO_STORED_HARNESS_ROWS))
      .rejects.toMatchObject({ code: 'HARNESS_FACTS_ABSENT', contentKey: keyOf(files['CLAUDE.md']) });
    expect(derive).toHaveBeenCalledTimes(1);
  });

  describe('a read the worker refuses', () => {
    const files = {
      'CLAUDE.md': '# acme\n\n@docs/a.md\n@docs/deep.md\n',
      'docs/a.md': '# a\n\n@b.md\n',
      'docs/b.md': '# b — widgets\n',
      'docs/deep.md': '# deep — refused\n\n@c.md\n',
      'docs/c.md': '# c — reached only through the refused file\n',
    };

    it.each([
      ['a limit', new ParseLimitError('stackMb', 4), BLOB_PARSE_LIMIT_EXCEEDED, 'RESOURCE_PARSE_LIMIT_EXCEEDED'],
      ['a dead worker', new ParseWorkerDiedError({ exitCode: 1 }), BLOB_PARSE_WORKER_DIED, 'RESOURCE_PARSE_WORKER_DIED'],
    ])('at %s is a per-run condition row, never a facts row, and the rest survive', async (_label, error, blobCode, findingCode) => {
      const builder = builderFor(files);
      const derive = refusing(files['docs/deep.md'], error);

      const result = await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), derive, NO_STORED_HARNESS_ROWS);

      expect(result).toMatchObject({ derived: 3, refused: 1, unreadable: 0 });
      expect(derivedPaths(builder, files)).toEqual(['CLAUDE.md', 'docs/a.md', 'docs/b.md']);
      const deepKey = keyOf(files['docs/deep.md']);
      expect(builder.base().harnessBlobFacts.some((row) => row.blob === deepKey)).toBe(false);
      expect(builder.base().blobConditions.filter((row) => row.blob === deepKey).map((row) => row.code)).toEqual([blobCode]);
      // Settled, not stuck: the refused blob leaves the frontier, and its imports are never followed.
      expect(harnessFrontier(builder.base(), CLAUDE_CODE)).toEqual([]);
      expect(derive).toHaveBeenCalledTimes(4);

      const projection = builder.build();
      expect(notAdmittedRealizations(projection, ROOT).parseRefused).toEqual([
        expect.objectContaining({ filePath: `${ROOT}/docs/deep.md`, code: findingCode }),
      ]);
      expect(describeBlobRefusals(projection)).toMatch(/declined 1 of 5 blob\(s\) \((1 over a parse limit|1 parse worker died)\)/);
    });

    it('propagates anything that is not a per-run refusal', async () => {
      const builder = builderFor(files);
      const broken = Object.assign(new Error('cannot load the reader'), { code: 'VAT_PARSER_UNAVAILABLE' });

      await expect(runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), refusing(files['docs/deep.md'], broken), NO_STORED_HARNESS_ROWS)).rejects.toBe(broken);
      expect(builder.base().blobConditions).toEqual([]);
    });
  });

  it('counts bytes that no longer key to the blob as unreadable, never deriving from them', async () => {
    const files = { 'CLAUDE.md': '# acme\n\n@a.md\n', 'a.md': '# a\n' };
    const builder = builderFor(files);
    const rewritten: RunContentSource = { read: () => Promise.resolve(keyContent('# rewritten\n', 'markdown')) };
    const derive = spiedDeriver();

    const result = await runHarnessPass(builder, [CLAUDE_CODE], rewritten, derive, NO_STORED_HARNESS_ROWS);

    expect(result.unreadableKeys).toEqual(new Set([keyOf(files['CLAUDE.md'])]));
    expect(derive).not.toHaveBeenCalled();
  });
});

// A chain of three reached pairs (CLAUDE.md, docs/a.md, docs/b.md), and docs/c.md, reached by nothing.
const TIER_FILES = {
  'CLAUDE.md': '# acme\n\n@docs/a.md\n',
  'docs/a.md': '# a\n\n@b.md\n',
  'docs/b.md': '# b — widgets\n',
  'README.md': '# readme\n\n@docs/c.md\n',
  'docs/c.md': '# c — never loaded\n',
};

/**
 * The stored rows a store would hold for `stored` (what an earlier run derived for them), every
 * file's key covered.
 */
async function tierHolding(stored: readonly string[]): Promise<ReturnType<typeof storedHarnessRows>> {
  const rows = await Promise.all(stored.map(async (path) => {
    const text = TIER_FILES[path as keyof typeof TIER_FILES];
    return harnessRowsFor(keyOf(text), CLAUDE_CODE.id, await IN_PROCESS_HARNESS_FACTS(CLAUDE_CODE.id, keyContent(text, 'markdown')));
  }));
  return storedHarnessRows({
    rows: { ...emptyBlobRows(), harnessBlobFacts: rows.map((row) => row.facts), harnessBlobImports: rows.flatMap((row) => row.imports) },
    covered: new Set(Object.values(TIER_FILES).map((text) => keyOf(text))),
  });
}

/** One pass over a fresh builder, counting the content source's reads and the pairs derived. */
async function passOverTier(stored: readonly string[]): Promise<{
  builder: ProjectionBuilder;
  result: Awaited<ReturnType<typeof runHarnessPass>>;
  reads: number;
  pairsDerived: number;
}> {
  const builder = builderFor(TIER_FILES);
  const source = readerOver(TIER_FILES);
  const read = vi.fn(source.read);
  const before = readWorkCounters()['harness.pairsDerived'];
  const result = await runHarnessPass(builder, [CLAUDE_CODE], { read }, IN_PROCESS_HARNESS_FACTS, await tierHolding(stored));
  return { builder, result, reads: read.mock.calls.length, pairsDerived: readWorkCounters()['harness.pairsDerived'] - before };
}

/** The pair `path`'s blob makes with Claude Code. */
function pairOf(path: keyof typeof TIER_FILES): HarnessPair {
  return { contentKey: keyOf(TIER_FILES[path]), harness: CLAUDE_CODE.id };
}

describe('runHarnessPass over a stored tier', () => {
  it('served pairs are not re-derived', async () => {
    const { builder, result, reads, pairsDerived } = await passOverTier(['CLAUDE.md', 'docs/a.md', 'docs/c.md']);

    expect(pairsDerived, 'only the pair the store does not hold is derived').toBe(1);
    expect(reads, 'the content source is asked for that pair alone').toBe(1);
    expect(result.served).toEqual([pairOf('CLAUDE.md'), pairOf('docs/a.md')]);
    expect(derivedPaths(builder, TIER_FILES), 'a stored pair the run does not reach never enters the builder')
      .toEqual(['CLAUDE.md', 'docs/a.md', 'docs/b.md']);
  });

  it('a newly reached pair is derived', async () => {
    // docs/a.md is covered, but the store never reached it, so it holds no pair for it.
    const { builder, result, pairsDerived } = await passOverTier(['CLAUDE.md']);

    expect(pairsDerived).toBe(2);
    expect(result.served).toEqual([pairOf('CLAUDE.md')]);
    const storeOff = builderFor(TIER_FILES);
    await runHarnessPass(storeOff, [CLAUDE_CODE], readerOver(TIER_FILES), IN_PROCESS_HARNESS_FACTS, NO_STORED_HARNESS_ROWS);
    expect(builder.build().harnessBlobFacts, 'the derived pairs are what a run with no store derives')
      .toEqual(storeOff.build().harnessBlobFacts);
  });

  it('serves a pair\'s stored imports in the order the pass derives them, whatever order the store returns', async () => {
    const memory = '# m\n\n@docs/a.md\n@docs/b.md\n@docs/c.md\n';
    const { facts, imports } = harnessRowsFor(keyOf(memory), CLAUDE_CODE.id, await IN_PROCESS_HARNESS_FACTS(CLAUDE_CODE.id, keyContent(memory, 'markdown')));
    expect(imports.map((row) => row.ordinal), 'the premise: three imports, derived in ordinal order').toEqual([0, 1, 2]);

    const stored = storedHarnessRows({
      rows: { ...emptyBlobRows(), harnessBlobFacts: [facts], harnessBlobImports: imports.toReversed() },
      covered: new Set([keyOf(memory)]),
    });

    expect(stored.rowsFor({ contentKey: keyOf(memory), harness: CLAUDE_CODE.id })?.imports).toEqual(imports);
  });
});
