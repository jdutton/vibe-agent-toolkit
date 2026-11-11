/**
 * The LAZY harness pass: Claude Code's memory facts are derived only for the
 * blobs its loader can reach — every entry point, followed through its own
 * imports for four hops — plus every member of a declared `claude-import`
 * extent, and for nothing else.
 */

import { compareCodeUnits, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { computeContentKey } from '../src/content-key.js';
import { ParseLimitError, ParseWorkerDiedError } from '../src/parse-limits.js';
import { BLOB_PARSE_LIMIT_EXCEEDED, BLOB_PARSE_WORKER_DIED } from '../src/projection/blob-population.js';
import { describeBlobRefusals, notAdmittedRealizations } from '../src/projection/blob-refusals.js';
import { RunContentCache } from '../src/projection/content-cache.js';
import { extentContextId } from '../src/projection/contributors/context-id.js';
import { CLAUDE_CODE, CLAUDE_OVERSIZE_BYTES } from '../src/projection/harness/claude-code.js';
import { runHarnessPass, type HarnessContentReader, type HarnessFactsDeriver } from '../src/projection/harness/harness-pass.js';
import { harnessFrontier } from '../src/projection/harness/reach.js';
import { ProjectionBuilder } from '../src/projection/projection.js';
import { ExtentDeclarationSchema, type ReferenceDialect } from '../src/schemas/project-config.js';
import type { JsonValue } from '../src/schemas/projection-shared.js';

import { addFile, IN_PROCESS_HARNESS_FACTS } from './helpers/claude-context-fixture.js';

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
  return vi.fn((harness: Parameters<HarnessFactsDeriver>[0], content: string) =>
    content === refused ? Promise.reject(error) : IN_PROCESS_HARNESS_FACTS(harness, content)) as HarnessFactsDeriver & ReturnType<typeof vi.fn>;
}

/** A reader over the fixture's own file map — never the disk. */
function readerOver(files: Readonly<Record<string, string>>): HarnessContentReader {
  return (entry) => Promise.resolve(files[entry.path] ?? null);
}

/** A builder holding the files — realizations, blobs, NO harness facts. */
function builderFor(files: Readonly<Record<string, string>>, deferred: readonly string[] = []): ProjectionBuilder {
  const builder = new ProjectionBuilder({ root: ROOT, contentCache: new RunContentCache({ inputBytes: null }) });
  builder.addRoot({ id: builder.identities.rootId, path: ROOT });
  for (const [path, markdown] of Object.entries(files)) {
    addFile(builder, { path, refs: [], markdown, deferred: deferred.includes(path) }, ROOT);
  }
  return builder;
}

/** The content key a fixture file's bytes are filed under. */
function keyOf(markdown: string): string {
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
  const result = await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), derive);
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
    expect(result).toEqual({ derived: 3, refused: 0, unreadable: 0, unreadableKeys: new Set() });
  });

  it('stops at four hops', async () => {
    const files = chain('CLAUDE.md', 'c', 5);
    const builder = builderFor(files);

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS);

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

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS);

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

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS);

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
    const builder = new ProjectionBuilder({ root: ROOT, contentCache: new RunContentCache({ inputBytes: null }) });
    builder.addRoot({ id: builder.identities.rootId, path: ROOT });
    // Planted FIRST so `addFile`'s own blob row for these bytes is the duplicate:
    // the cliff is about `blobs.bytes`, and 4 MiB of real text would cost the
    // parser most of a second to say nothing new.
    builder.addBlob({ ...realBlob, bytes: CLAUDE_OVERSIZE_BYTES + 1 });
    for (const [path, markdown] of Object.entries(files)) addFile(builder, { path, refs: [], markdown }, ROOT);
    expect(builder.base().blobs.find((row) => row.contentKey === keyOf(files['big.md']))?.bytes).toBe(CLAUDE_OVERSIZE_BYTES + 1);

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS);

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

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), derive);

    expect(builder.base().harnessBlobFacts.filter((row) => row.blob === keyOf(shared))).toHaveLength(1);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  it('skips an unkeyed realization', async () => {
    const files = { 'CLAUDE.md': '# acme\n\n@a.md\n', 'a.md': '# a\n' };
    const builder = builderFor(files, ['CLAUDE.md']);

    const result = await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS);

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

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS);

    expect(derivedPaths(builder, files)).toEqual(['.claude/rules/r.md', 'acme/CLAUDE.local.md', 'acme/widgets/.claude/CLAUDE.md']);
  });

  it('covers members of a declared claude-import extent beyond four hops', async () => {
    const files = chain('CLAUDE.md', 'c', 6);
    const builder = builderFor(files);
    plantExtent(builder, { closureFrom: 'CLAUDE.md', maxDepth: 4, dialect: 'claude-import', members: ['docs/c6.md'] });

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS);

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

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS);

    expect(derivedPaths(builder, files)).toEqual(Object.keys(files).sort(compareCodeUnits));
  });

  it('reads the dialect off the declaration, so an href extent is not the harness\'s', async () => {
    const files = chain('docs/start.md', 'd', 2);
    const builder = builderFor(files);
    plantExtent(builder, { closureFrom: 'docs/start.md', maxDepth: 'full', dialect: 'href', members: ['docs/d2.md'] });

    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), IN_PROCESS_HARNESS_FACTS);

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
    const builder = new ProjectionBuilder({ root: ROOT, contentCache: new RunContentCache({ inputBytes: null }) });
    addFile(builder, { path: 'CLAUDE.md', refs: [], markdown: '# acme\n' }, ROOT);

    expect(() => harnessFrontier(builder.base(), CLAUDE_CODE)).toThrow(/no root/);
  });

  it('returns 0 on a settled projection', async () => {
    const files = { 'CLAUDE.md': '# acme\n\n@a.md\n', 'a.md': '# a\n' };
    const builder = builderFor(files);
    const derive = spiedDeriver();
    await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), derive);
    derive.mockClear();

    const second = await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), derive);

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
    const reader: HarnessContentReader = (entry) =>
      Promise.resolve(entry.path === 'docs/a.md' ? null : files[entry.path as keyof typeof files] ?? null);

    const result = await runHarnessPass(builder, [CLAUDE_CODE], reader, IN_PROCESS_HARNESS_FACTS);

    expect(result.unreadable).toBe(1);
    expect(result.unreadableKeys).toEqual(new Set([keyOf(files['docs/a.md'])]));
    expect(derivedPaths(builder, files)).toEqual(['CLAUDE.md']);
  });

  it('refuses with HARNESS_FACTS_ABSENT, never loops, when a derived blob stays on the frontier', async () => {
    const files = { 'CLAUDE.md': '# acme\n\n@a.md\n', 'a.md': '# a\n' };
    const builder = builderFor(files);
    // A pass that files neither a facts row nor a condition row for what it
    // derived — the shape that re-demanded the same key forever (ADR I8).
    vi.spyOn(builder, 'addHarnessBlobFacts').mockImplementation(() => undefined);
    const derive = spiedDeriver();

    await expect(runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), derive))
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

      const result = await runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), derive);

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

      await expect(runHarnessPass(builder, [CLAUDE_CODE], readerOver(files), refusing(files['docs/deep.md'], broken))).rejects.toBe(broken);
      expect(builder.base().blobConditions).toEqual([]);
    });
  });
});
