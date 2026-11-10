import { chmodSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS, overOutputRowsMarkdown } from '@vibe-agent-toolkit/utils/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { RESOURCES_SCAN_REPORT_SCHEMA } from '../../src/commands/resources/scan-schema.js';

import {
  getBinPath,
  createTestTempDir,
  cleanupTestTempDir,
  writeTestFile,
  executeCli,
  executeCliAndParseYaml,
} from './test-common.js';

const binPath = getBinPath(import.meta.url);

describe('vat resources scan (system test)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTestTempDir('vat-scan-test-');
  });

  afterEach(() => {
    cleanupTestTempDir(tempDir);
  });

  it('should scan directory and output YAML', async () => {
    // Create test markdown files
    writeTestFile(safePath.join(tempDir, 'README.md'), '# Test\n[link](./other.md)');
    writeTestFile(safePath.join(tempDir, 'other.md'), '# Other');

    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'resources',
      'scan',
      tempDir,
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('---');
    const report = RESOURCES_SCAN_REPORT_SCHEMA.parse(parsed);
    expect(report.status).toBe('ok');
    expect(report.examined).toBe(2);
  });

  it('emits the same document as JSON, parseable without a YAML parser', async () => {
    writeTestFile(safePath.join(tempDir, 'README.md'), '# Test');

    const result = await executeCli(binPath, [
      'resources',
      'scan',
      tempDir,
      '--verbose',
      '--format',
      'json',
    ]);

    expect(result.status).toBe(0);
    // `JSON.parse` of the whole stream, not a substring match: the point of the
    // flag is that a consumer needs no parser of ours, and a document with a
    // stray `---` opener or a trailing second document fails exactly here.
    const report = RESOURCES_SCAN_REPORT_SCHEMA.parse(JSON.parse(result.stdout));
    expect(report.status).toBe('ok');
    // The projection lane is the default; this fixture has no `.git`, so it is
    // the filesystem enumerator that runs under it.
    expect(report.data.lane).toBe('projection');
    expect(report.data.extentSource).toBe('filesystem');
    expect(report.data.files).toHaveLength(1);
  });

  it('refuses an output format it does not have', async () => {
    const result = await executeCli(binPath, ['resources', 'scan', tempDir, '--format', 'xml']);

    // Loud, not a silent fall back to YAML: a caller who asked for a format and
    // got another one parses the wrong thing and blames the parser.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('--format');
  });

  it('refuses a scan of nothing: exit 1 and one RESOURCE_CHECK_BROKEN, never a clean empty population', async () => {
    const { result, parsed } = await executeCliAndParseYaml(binPath, ['resources', 'scan', tempDir]);

    // A scan of zero files reads exactly like a scan of a tree whose files the
    // enumeration lost; the writer refuses it from the declared denominator.
    expect(result.status).toBe(1);
    const report = RESOURCES_SCAN_REPORT_SCHEMA.parse(parsed);
    expect(report.examined).toBe(0);
    expect(report.findings.map((finding) => finding.code)).toEqual(['RESOURCE_CHECK_BROKEN']);
  });

  // A document over the parse pool's DEFAULT `outputRows` (16,384): 20,000 links is
  // real and cheap. Its parse is refused, so it is in no list the registry hands
  // the scan — and the scan used to report the survivors as the whole population,
  // `status: ok`, exit 0. Both lanes, because each crawls through its own route.
  it.each(['projection', 'walk'])(
    'reports a file whose parse was refused as an error finding and counts it examined (%s lane)',
    async (lane) => {
      writeTestFile(safePath.join(tempDir, 'good.md'), '# Good\n');
      writeTestFile(safePath.join(tempDir, 'huge.md'), overOutputRowsMarkdown('good.md'));

      const { result, parsed } = await executeCliAndParseYaml(
        binPath,
        ['resources', 'scan', tempDir],
        { env: { VAT_RESOURCES_CRAWL: lane } },
      );

      expect(result.status).toBe(1);
      const report = RESOURCES_SCAN_REPORT_SCHEMA.parse(parsed);
      expect(report.status).toBe('findings');
      expect(report.examined).toBe(2);
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0]).toMatchObject({ code: 'RESOURCE_PARSE_LIMIT_EXCEEDED', severity: 'error', location: 'huge.md' });
      expect(report.findings[0]?.message).toContain('outputRows');
    },
  );

  // The same hole, by the read rather than the parse: `chmod 000` denies nothing to
  // uid 0 and does not exist on Windows.
  it.skipIf(CANNOT_DENY_READS)('reports a file it could not read as RESOURCE_UNREADABLE and counts it examined', async () => {
    writeTestFile(safePath.join(tempDir, 'good.md'), '# Good\n');
    const locked = safePath.join(tempDir, 'locked.md');
    writeTestFile(locked, '# Locked\n');
    chmodSync(locked, 0o000);

    const { result, parsed } = await executeCliAndParseYaml(binPath, ['resources', 'scan', tempDir]);
    chmodSync(locked, 0o600);

    expect(result.status).toBe(1);
    const report = RESOURCES_SCAN_REPORT_SCHEMA.parse(parsed);
    expect(report.examined).toBe(2);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ code: 'RESOURCE_UNREADABLE', severity: 'error', location: 'locked.md' });
  });

  it('should use current directory if no path provided', async () => {
    writeTestFile(safePath.join(tempDir, 'test.md'), '# Test');

    const result = await executeCli(binPath, ['resources', 'scan'], { cwd: tempDir });

    expect(result.status).toBe(0);
  });

  it('should scan multiple files successfully', async () => {
    // Create test files
    writeTestFile(safePath.join(tempDir, 'doc1.md'), '# Same Content\nThis is identical.');
    writeTestFile(safePath.join(tempDir, 'doc2.md'), '# Same Content\nThis is identical.');
    writeTestFile(safePath.join(tempDir, 'unique.md'), '# Different Content');

    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'resources',
      'scan',
      tempDir,
    ]);

    expect(result.status).toBe(0);
    expect(RESOURCES_SCAN_REPORT_SCHEMA.parse(parsed).examined).toBe(3);
  });

  // Previously skipped as "--verbose conflicts with the parent command's
  // --verbose". There is no parent `--verbose`: `resources` declares none, and
  // `scan` declares its own. The skip outlived whatever provoked it and took
  // the ONLY coverage of the `files:` list — and of its paths — with it.
  it('should include checksums in file output with --verbose flag', async () => {
    writeTestFile(safePath.join(tempDir, 'test.md'), '# Test');

    const { result, parsed } = await executeCliAndParseYaml(binPath, [
      'resources',
      'scan',
      tempDir,
      '--verbose',
    ]);

    expect(result.status).toBe(0);
    const files = RESOURCES_SCAN_REPORT_SCHEMA.parse(parsed).data.files ?? [];
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toHaveProperty('checksum');
    expect(files[0]?.checksum).toMatch(/^[a-f0-9]{64}$/); // SHA-256 format
  });

  it('states one root and reports every --verbose path relative to it', async () => {
    // The payload is machine-readable output. An absolute path in it names the
    // operator's home directory and makes two machines' runs undiffable, so the
    // document states its base once and everything under it is relative — the
    // same contract `vat audit` follows.
    // Nested on purpose: a bare filename would also satisfy a `basename()`
    // near-miss, so the subdirectory is what proves the path was re-based.
    mkdirSyncReal(safePath.join(tempDir, 'nested'), { recursive: true });
    writeTestFile(safePath.join(tempDir, 'nested', 'test.md'), '# Test');

    const { parsed } = await executeCliAndParseYaml(binPath, [
      'resources',
      'scan',
      tempDir,
      '--verbose',
    ]);

    const report = RESOURCES_SCAN_REPORT_SCHEMA.parse(parsed);
    expect(report.data.root).toBeDefined();
    expect(report.data.files?.map(f => f.path)).toEqual(['nested/test.md']);
  });
});
