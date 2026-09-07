/**
 * The checks an external adopter's first real run of `vat claude org skills`
 * asked for, each pinned at the seam that was actually missing.
 *
 * Every case here comes from a measured failure against the live API or a
 * measured gap in what VAT looked at, not from a hypothetical:
 *
 * - A ZIP passes the request-body gate on its COMPRESSED bytes, and the API
 *   then expands it and refuses on the uncompressed total. Measured: a
 *   10,707,463-byte archive of a 47.85 MiB tree came back
 *   `400: Zip file uncompressed size exceeds 30MB`.
 * - A ZIP's display title comes from its FILENAME while its versions carry the
 *   name its inner SKILL.md declares, so VAT itself mints title≠name skills.
 * - `install` weighed the request and sent it, running none of the checks VAT
 *   owns. An adopter published 10 of 54 skills that referenced paths outside
 *   their own tree — green tick, cannot run.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { API_SKILL_MAX_UPLOAD_BYTES } from '@vibe-agent-toolkit/agent-skills';
import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inspectZipArchive, warnUnportableReferences } from '../src/commands/claude/org/skills.js';

import type { ZipFixtureEntry } from './helpers/zip-fixtures.js';
import { skillMdBytes, writeZipFixture } from './helpers/zip-fixtures.js';

let tempDir: string;

/** A logger that keeps warnings separately, so a test can assert nothing was said. */
function warnRecorder(): { info: (m: string) => void; warn: (m: string) => void; warnings: string[] } {
  const warnings: string[] = [];
  return { info: () => undefined, warn: (m: string) => warnings.push(m), warnings };
}

/** The document name every fixture bundle uses; repeated enough to be a constant. */
const SKILL_MD = 'demo/SKILL.md';

/** One uploaded file, as `prepareSkillUpload` would have assembled it. */
function uploadFile(filename: string, body: string): { fieldName: string; filename: string; content: Buffer } {
  return { fieldName: 'files[]', filename, content: Buffer.from(body, 'utf8') };
}

/** Write an archive of `[entryName, bytes]` pairs into this suite's temp dir. */
function writeZip(fileName: string, entries: readonly ZipFixtureEntry[]): string {
  return writeZipFixture(tempDir, fileName, entries);
}

/** The bundled fixture SKILL.md the depth rule must NOT elect. */
const NESTED_SKILL_MD = 'demo/resources/example/SKILL.md';

/** The root SKILL.md of the archive fixtures that model a real bundle. */
const BUNDLE_SKILL_MD = 'my-skill/SKILL.md';

beforeAll(() => {
  tempDir = safePath.join(normalizedTmpdir(), `vat-adopter-findings-${process.pid}`);
  mkdirSyncReal(tempDir, { recursive: true });
});

afterAll(async () => {
  const { rmSync } = await import('node:fs');
  rmSync(tempDir, { recursive: true, force: true });
});

describe('inspectZipArchive', () => {
  it('reports the UNCOMPRESSED total, not the archive size', async () => {
    // Highly compressible: small on the wire, large once expanded. That gap is
    // the entire defect — a check on archive bytes cannot see it.
    const zipPath = writeZip('compressible.zip', [
      ['demo/payload.bin', Buffer.alloc(4 * 1024 * 1024, 0x41)],
      [SKILL_MD, skillMdBytes('demo')],
    ]);

    const inspected = await inspectZipArchive(zipPath);

    expect(inspected).toBeDefined();
    expect(inspected?.uncompressedBytes).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    // The property that makes this worth measuring at all.
    const { statSync } = await import('node:fs');
    expect(statSync(zipPath).size).toBeLessThan(inspected?.uncompressedBytes ?? 0);
  });

  it('reads the declared name out of the archive, which is what makes a title divergence visible', async () => {
    const zipPath = writeZip('wiki-lint-v2.zip', [['wiki-lint/SKILL.md', skillMdBytes('wiki-lint')]]);

    const inspected = await inspectZipArchive(zipPath);

    // `wiki-lint-v2.zip` would publish under the filename; the archive says
    // otherwise, and now VAT can tell the operator so.
    expect(inspected?.declaredName).toBe('wiki-lint');
  });

  it('returns undefined for an unreadable archive rather than blocking the publish', async () => {
    const notAZip = safePath.join(tempDir, 'corrupt.zip');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own temp dir
    writeFileSync(notAZip, 'this is not a zip archive');

    // VAT failing to parse an archive is not grounds to refuse an upload the API
    // is the authority on. Degrade, do not destroy.
    await expect(inspectZipArchive(notAZip)).resolves.toBeUndefined();
  });

  /**
   * "Shallowest wins" was implemented as "SHORTEST ENTRY NAME wins", which is a
   * different rule wherever a short deep path meets a long shallow one. Here
   * `a/b/SKILL.md` is 12 characters at depth 2 and `my-skill-bundle/SKILL.md` is
   * 24 at depth 1: the length rule elects the bundled FIXTURE, so VAT reported
   * the fixture's name and advised the operator to `--title` it.
   */
  it('elects the SKILL.md at the shallowest DEPTH, not the one with the shortest name', async () => {
    const zipPath = writeZip('depth-vs-length.zip', [
      ['my-skill-bundle/SKILL.md', skillMdBytes('bundle')],
      ['a/b/SKILL.md', skillMdBytes('nested-fixture')],
    ]);

    await expect(inspectZipArchive(zipPath)).resolves.toMatchObject({ declaredName: 'bundle' });
  });

  /**
   * The election and the name it reports must come from ONE document. The old
   * `declaredSkillNameIn(…) ?? declaredName` KEPT the previously-elected deeper
   * entry's name whenever the newly-elected shallower SKILL.md declared none, so
   * the two were sourced from different files and the divergence warning quoted
   * a name that appears nowhere near the archive root.
   */
  it('reports no name when the elected SKILL.md declares none, rather than inheriting a deeper one', async () => {
    const zipPath = writeZip('elected-has-no-name.zip', [
      // Written FIRST, so a stateful reader elects it before seeing the root one.
      [NESTED_SKILL_MD, skillMdBytes('bundled-fixture')],
      [SKILL_MD, Buffer.from('---\ndescription: No name field at all.\n---\n', 'utf8')],
    ]);

    const inspected = await inspectZipArchive(zipPath);

    expect(inspected?.declaredName).toBeUndefined();
  });

  /** The elected entry cannot depend on the order the archive happens to store in. */
  it.each([
    ['root first', [[SKILL_MD, 'demo'], [NESTED_SKILL_MD, 'other']]],
    ['root last', [[NESTED_SKILL_MD, 'other'], [SKILL_MD, 'demo']]],
  ] as const)('elects the root SKILL.md whichever order it was written (%s)', async (label, order) => {
    const zipPath = writeZip(
      `order-${label.replace(' ', '-')}.zip`,
      order.map(([entryName, name]) => [entryName, skillMdBytes(name)] as [string, Buffer]),
    );

    await expect(inspectZipArchive(zipPath)).resolves.toMatchObject({ declaredName: 'demo' });
  });

  /**
   * `getData()` used to sit OUTSIDE the try/catch that guards the archive read.
   * adm-zip throws from it on BAD_CRC, on any compression method but
   * store/deflate, and on a password-protected entry — so those escaped and
   * killed `install <x>.zip` on exit 2, contradicting this function's own stance
   * that an archive VAT cannot parse is not an archive VAT should block.
   *
   * The unsupported-method case is minted by hand rather than mocked: the
   * central directory's compression-method field is the one byte pair that
   * decides it, and adm-zip refuses the entry the moment it is asked to inflate.
   * The SIZE total must survive, because it never needed the entry's bytes.
   */
  it('survives an entry it cannot decompress, keeping the size total it read from headers', async () => {
    const goodPath = writeZip('unsupported-method-source.zip', [[SKILL_MD, skillMdBytes('demo')]]);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own temp dir
    const bytes = readFileSync(goodPath);
    const centralDirectory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralDirectory).toBeGreaterThan(0);
    bytes.writeUInt16LE(99, centralDirectory + 10);
    const zipPath = safePath.join(tempDir, 'unsupported-method.zip');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- our own temp dir
    writeFileSync(zipPath, bytes);

    const inspected = await inspectZipArchive(zipPath);

    expect(inspected).toBeDefined();
    expect(inspected?.declaredName).toBeUndefined();
    expect(inspected?.uncompressedBytes).toBeGreaterThan(0);
  });

  /**
   * `getData()` allocates whatever `header.size` claims, and a header can claim
   * anything. Bounding it is the only thing standing between an archive and an
   * allocation VAT performs on its say-so.
   */
  it('does not inflate a SKILL.md far larger than any real one', async () => {
    const zipPath = writeZip('huge-skill-md.zip', [
      [SKILL_MD, skillMdBytes('demo', 'x'.repeat(2 * 1024 * 1024))],
    ]);

    await expect(inspectZipArchive(zipPath)).resolves.toMatchObject({ declaredName: undefined });
  });

  /**
   * The ceiling refusal must be decided BEFORE anything is decompressed, or the
   * gate cannot protect the allocation that precedes it. Nothing observable says
   * "did not inflate" directly — but the name is the only thing inflation
   * produces, so its absence on an over-ceiling archive is the trace.
   */
  it('reads no name out of an archive already over the ceiling', async () => {
    const zipPath = writeZip('over-ceiling-inspect.zip', [
      [SKILL_MD, skillMdBytes('demo')],
      ['demo/payload.bin', Buffer.alloc(API_SKILL_MAX_UPLOAD_BYTES + 1, 0x41)],
    ]);

    const inspected = await inspectZipArchive(zipPath);

    expect(inspected?.uncompressedBytes).toBeGreaterThan(API_SKILL_MAX_UPLOAD_BYTES);
    expect(inspected?.declaredName).toBeUndefined();
  });

  /**
   * The one lane that COULD see an answer key inside an archive now does. It
   * enumerates every entry name anyway; saying nothing about `evals/` was the
   * gap that let `zip -r my-skill.zip my-skill/` publish the suite org-wide.
   */
  it('names the never-uploaded entries an archive carries', async () => {
    const zipPath = writeZip('carries-evals.zip', [
      [BUNDLE_SKILL_MD, skillMdBytes('my-skill')],
      ['my-skill/evals/evals.json', Buffer.from('{"evals":[]}', 'utf8')],
      ['my-skill/node_modules/dep/index.js', Buffer.from('module.exports = {};', 'utf8')],
    ]);

    const inspected = await inspectZipArchive(zipPath);

    expect(inspected?.neverUploaded).toContain('my-skill/evals/evals.json');
    expect(inspected?.neverUploaded).toContain('my-skill/node_modules/dep/index.js');
    expect(inspected?.neverUploaded).not.toContain(BUNDLE_SKILL_MD);
  });

  it('reports no never-uploaded entries for a clean built bundle', async () => {
    const zipPath = writeZip('clean-bundle.zip', [
      [BUNDLE_SKILL_MD, skillMdBytes('my-skill')],
      ['my-skill/resources/guide.md', Buffer.from('# Guide\n', 'utf8')],
    ]);

    await expect(inspectZipArchive(zipPath)).resolves.toMatchObject({ neverUploaded: [] });
  });
});

describe('warnUnportableReferences', () => {
  /** The bundle root every fixture's parts are keyed under. */
  const BUNDLE_ROOT = 'demo';

  /** A document that trips the non-portable asset-reference family. */
  const UNPORTABLE_DOC = '# Demo\n\nRun `node "${CLAUDE_PLUGIN_ROOT}/../other/x.mjs"` first.\n';

  it('warns about a reference that cannot resolve once the skill is published alone', () => {
    const logger = warnRecorder();

    warnUnportableReferences([uploadFile(SKILL_MD, UNPORTABLE_DOC)], BUNDLE_ROOT, undefined, logger);

    expect(logger.warnings.join('\n')).toContain('CLAUDE_PLUGIN_ROOT');
    // It must say it is NOT blocking, or an operator reads a warning as a failure.
    expect(logger.warnings.join('\n')).toContain('uploading anyway');
  });

  it('says nothing about a clean bundle', () => {
    const logger = warnRecorder();

    warnUnportableReferences(
      [uploadFile(SKILL_MD, '# Demo\n\nRun `node scripts/run.mjs` first.\n')],
      BUNDLE_ROOT,
      undefined,
      logger,
    );

    expect(logger.warnings).toEqual([]);
  });

  it('does not read non-markdown payload bytes as instructions', () => {
    const logger = warnRecorder();

    // The same text that fires above, in a file no agent reads as prose.
    warnUnportableReferences(
      [uploadFile('demo/logo.png', 'node "${CLAUDE_PLUGIN_ROOT}/../other/x.mjs"')],
      BUNDLE_ROOT,
      undefined,
      logger,
    );

    expect(logger.warnings).toEqual([]);
  });

  /**
   * The location is what a `validation.allow` glob is matched against, and
   * `ValidationIssue.location` is contractually BUNDLE-relative. This lane emitted
   * the API-keyed `<declared-name>/<path>` spelling instead, so an author copying
   * the path out of a publish warning wrote an allow entry that matched nothing —
   * exactly the divergence `bundleRelativeName` exists to strip out of the
   * oversize message.
   */
  it('locates a finding by its bundle-relative path, not the API-keyed one', () => {
    const logger = warnRecorder();

    warnUnportableReferences([uploadFile(SKILL_MD, UNPORTABLE_DOC)], BUNDLE_ROOT, undefined, logger);

    const said = logger.warnings.join('\n');
    expect(said).toContain('SKILL.md');
    expect(said).not.toContain('demo/SKILL.md');
  });

  /**
   * 🚨 The registry text for `MCP_TOOL_NAME_UNQUALIFIED` tells authors to "waive
   * that one identifier with a `validation.allow` entry". An author who followed
   * VAT's own documented remedy got a green `vat skills build` and then this
   * warning on EVERY publish, with nothing left to silence it — because this lane
   * printed RAW issues and never ran the framework that honours the waiver.
   */
  it('honours a validation.allow entry the way every other VAT lane does', () => {
    const logger = warnRecorder();

    warnUnportableReferences(
      [uploadFile(SKILL_MD, UNPORTABLE_DOC)],
      BUNDLE_ROOT,
      {
        allow: {
          NON_PORTABLE_ASSET_REFERENCE: [
            { paths: ['SKILL.md'], reason: 'Bundled beside a sibling on purpose.' },
          ],
        },
      },
      logger,
    );

    expect(logger.warnings).toEqual([]);
  });

  /** A `severity: ignore` override drops the finding, same as everywhere else. */
  it('honours a validation.severity override', () => {
    const logger = warnRecorder();

    warnUnportableReferences(
      [uploadFile(SKILL_MD, UNPORTABLE_DOC)],
      BUNDLE_ROOT,
      { severity: { NON_PORTABLE_ASSET_REFERENCE: 'ignore' } },
      logger,
    );

    expect(logger.warnings).toEqual([]);
  });

  /**
   * The framework's run-level ALLOW_UNUSED sweep must NOT be drained here: this
   * lane runs three validator families out of the whole registry, so an entry
   * waiving anything else would be reported as dead — advising the author to
   * delete the entry that keeps their build green.
   */
  it('never calls an allow entry for another code dead', () => {
    const logger = warnRecorder();

    warnUnportableReferences(
      [uploadFile(SKILL_MD, '# Demo\n\nNothing unportable here.\n')],
      BUNDLE_ROOT,
      {
        allow: {
          SKILL_DESCRIPTION_TOO_LONG: [{ paths: ['SKILL.md'], reason: 'Reviewed.' }],
        },
      },
      logger,
    );

    expect(logger.warnings).toEqual([]);
  });
});
