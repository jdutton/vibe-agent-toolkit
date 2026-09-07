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

import { writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import AdmZip from 'adm-zip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { inspectZipArchive, warnUnportableReferences } from '../src/commands/claude/org/skills.js';

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
    const zipPath = safePath.join(tempDir, 'compressible.zip');
    const zip = new AdmZip();
    // Highly compressible: small on the wire, large once expanded. That gap is
    // the entire defect — a check on archive bytes cannot see it.
    zip.addFile('demo/payload.bin', Buffer.alloc(4 * 1024 * 1024, 0x41));
    zip.addFile('demo/SKILL.md', Buffer.from('---\nname: demo\ndescription: x\n---\n', 'utf8'));
    zip.writeZip(zipPath);

    const inspected = await inspectZipArchive(zipPath);

    expect(inspected).toBeDefined();
    expect(inspected?.uncompressedBytes).toBeGreaterThanOrEqual(4 * 1024 * 1024);
    // The property that makes this worth measuring at all.
    const { statSync } = await import('node:fs');
    expect(statSync(zipPath).size).toBeLessThan(inspected?.uncompressedBytes ?? 0);
  });

  it('reads the declared name out of the archive, which is what makes a title divergence visible', async () => {
    const zipPath = safePath.join(tempDir, 'wiki-lint-v2.zip');
    const zip = new AdmZip();
    zip.addFile(
      'wiki-lint/SKILL.md',
      Buffer.from('---\nname: wiki-lint\ndescription: A skill whose archive is named differently.\n---\n', 'utf8'),
    );
    zip.writeZip(zipPath);

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
});

describe('warnUnportableReferences', () => {
  it('warns about a reference that cannot resolve once the skill is published alone', () => {
    const logger = warnRecorder();

    warnUnportableReferences(
      [uploadFile(SKILL_MD, '# Demo\n\nRun `node "${CLAUDE_PLUGIN_ROOT}/../other/x.mjs"` first.\n')],
      logger,
    );

    expect(logger.warnings.join('\n')).toContain('CLAUDE_PLUGIN_ROOT');
    // It must say it is NOT blocking, or an operator reads a warning as a failure.
    expect(logger.warnings.join('\n')).toContain('uploading anyway');
  });

  it('says nothing about a clean bundle', () => {
    const logger = warnRecorder();

    warnUnportableReferences(
      [uploadFile(SKILL_MD, '# Demo\n\nRun `node scripts/run.mjs` first.\n')],
      logger,
    );

    expect(logger.warnings).toEqual([]);
  });

  it('does not read non-markdown payload bytes as instructions', () => {
    const logger = warnRecorder();

    // The same text that fires above, in a file no agent reads as prose.
    warnUnportableReferences(
      [uploadFile('demo/logo.png', 'node "${CLAUDE_PLUGIN_ROOT}/../other/x.mjs"')],
      logger,
    );

    expect(logger.warnings).toEqual([]);
  });
});
