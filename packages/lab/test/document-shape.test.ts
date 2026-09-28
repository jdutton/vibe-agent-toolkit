/**
 * Classifying a command's stdout as a `Report<T>` envelope or a legacy
 * document.
 *
 * The trap this suite exists to catch: two documents can share a key's NAME —
 * `vat audit`'s legacy output has a `summary` key too, an object, same as the
 * envelope's — without agreeing on what it means. Classification must never
 * lean on that shared name; only `examined` (a number) and `findings` (an
 * array) are unique enough to the envelope to tell the two apart.
 */

import { readFileSync } from 'node:fs';

import { REPORT_ENVELOPE_KEYS } from '@vibe-agent-toolkit/schema';
import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { ENVELOPE_IDENTITY_KEYS, parseDocument } from '../src/harness/document-shape.js';

const FIXTURES = resolveFromImportMeta(import.meta.url, 'fixtures/verdict');

function fixture(name: string): string {
  return readFileSync(safePath.join(FIXTURES, name), 'utf-8');
}

describe('parseDocument', () => {
  it('classifies an rc.11 report with no gate as a report', () => {
    const parsed = parseDocument(fixture('report-okf-validate-rc11.json'));
    expect(parsed.shape).toBe('report');
  });

  it('classifies a gate-carrying report as a report', () => {
    const parsed = parseDocument(fixture('report-with-gate.json'));
    expect(parsed.shape).toBe('report');
  });

  it('classifies legacy audit as legacy although it carries summary and issueCounts', () => {
    const parsed = parseDocument(fixture('legacy-audit.yaml'));
    expect(parsed.shape).toBe('legacy');
  });

  it('classifies agent-skills ValidationResult (summary: string) as legacy', () => {
    const parsed = parseDocument(fixture('legacy-skills-validate-verbose.yaml'));
    expect(parsed.shape).toBe('legacy');
  });

  it('parses a YAML document opened with ---', () => {
    const parsed = parseDocument('---\nstatus: success\nfilesScanned: 1\n');
    expect(parsed.shape).toBe('legacy');
    if (parsed.shape === 'legacy') {
      expect(parsed.document).toEqual({ status: 'success', filesScanned: 1 });
    }
  });

  it('returns unparsed, with the reason, for two YAML documents', () => {
    const parsed = parseDocument('a: 1\n---\nb: 2\n');
    expect(parsed.shape).toBe('unparsed');
    if (parsed.shape === 'unparsed') {
      expect(parsed.reason).toContain('one YAML document');
    }
  });

  it('returns unparsed for a document that is neither JSON nor YAML', () => {
    const parsed = parseDocument('a: [1, 2\n');
    expect(parsed.shape).toBe('unparsed');
  });

  it('reads payload as data for a report and as the document itself for legacy', () => {
    const report = parseDocument(fixture('report-okf-validate-rc11.json'));
    const legacy = parseDocument(fixture('legacy-audit.yaml'));
    expect(report.shape).toBe('report');
    expect(legacy.shape).toBe('legacy');
    if (report.shape === 'report') {
      expect(report.payload).toEqual(report.document['data']);
    }
    if (legacy.shape === 'legacy') {
      expect(legacy.payload).toBe(legacy.document);
    }
  });

  it('classifies a document with all five keys present but the wrong types as legacy', () => {
    // Every ENVELOPE_IDENTITY_KEYS name is present, but `examined` is a string
    // and `findings` is not an array — key PRESENCE alone must not be enough.
    const parsed = parseDocument(JSON.stringify({
      status: 'ok',
      examined: 'three',
      findings: 'none',
      summary: {},
      data: null,
    }));
    expect(parsed.shape).toBe('legacy');
  });

  it('keeps the identity keys a subset of the live REPORT_ENVELOPE_KEYS', () => {
    for (const key of ENVELOPE_IDENTITY_KEYS) expect(REPORT_ENVELOPE_KEYS).toContain(key);
  });
});
