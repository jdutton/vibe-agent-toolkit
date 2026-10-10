/**
 * The one document writer: renders a registered verb's report in the operator's
 * format, derives the run-integrity refusal from the registry's denominator,
 * validates against the published schema before a byte leaves, and ends on the
 * code the written document derives.
 */

import { buildReport, ExitCode, type ErrorReport, type Finding, type Report } from '@vibe-agent-toolkit/schema';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import yaml from 'yaml';

import { PUBLISHED_SHAPES } from '../../src/report-schemas.js';
import { setDebugDiagnostics } from '../../src/utils/debug-diagnostics.js';
import {
  endWithRefusal,
  endWithReport,
  endWithForwardedDocument,
  readForwardedDocument,
  NOTHING_FINISHED,
  writeArtifact,
  writeArtifactFile,
  writeDocument,
  writeExternalDocument,
  writeLegacyDocument,
  type FinishedWork,
} from '../../src/utils/document-writer.js';
import type * as OutputModule from '../../src/utils/output.js';

// `writeStdoutSync` writes fd 1 directly, past the stdout spy; route it through the spy.
vi.mock('../../src/utils/output.js', async (importOriginal) => ({
  ...(await importOriginal<typeof OutputModule>()),
  writeStdoutSync: (content: string) => process.stdout.write(content),
}));

const VERB = 'okf validate';
const DATA = {
  bundles: [{ bundle: 'knowledge', root: './bundles/knowledge', conceptDocuments: ['a.md'], reservedDocuments: [] }],
};
const FINDING: Finding = {
  code: 'OKF_CONCEPT_MISSING_TYPE',
  severity: 'error',
  message: 'concept has no type',
  location: 'bundles/knowledge/a.md',
  line: 1,
};

let stdout: MockInstance<typeof process.stdout.write>;
let exit: MockInstance<typeof process.exit>;

beforeEach(() => {
  stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Everything the stderr spy saw, as one string. Read before the spies restore. */
function stderrText(): string {
  return (process.stderr.write as unknown as MockInstance<typeof process.stderr.write>).mock.calls.map((call) => String(call[0])).join('');
}

/** Everything the spy saw on stdout, as one string. Read before the spies restore. */
function written(): string {
  return stdout.mock.calls.map((call) => String(call[0])).join('');
}

function reportWith(examined: number, findings: readonly Finding[]): Report<typeof DATA> {
  return buildReport({ examined, findings, data: DATA, gate: { strict: false } });
}

describe('writeDocument', () => {
  it('renders the same report as yaml, json and text', () => {
    const report = reportWith(1, [FINDING]);

    writeDocument(VERB, report, 'yaml');
    const asYaml: unknown = yaml.parse(written());
    stdout.mockClear();
    writeDocument(VERB, report, 'json');
    const asJson: unknown = JSON.parse(written());
    stdout.mockClear();
    writeDocument(VERB, report, 'text');
    const asText = written();

    expect(asYaml).toStrictEqual(report);
    expect(asJson).toStrictEqual(report);
    expect(asText).toContain('bundles/knowledge/a.md:1: error: concept has no type [OKF_CONCEPT_MISSING_TYPE]');
    const unit = PUBLISHED_SHAPES.find((shape) => shape.kind === 'report' && shape.verbs.includes(VERB));
    expect(unit?.kind === 'report' ? unit.examined.unit : '').not.toBe('');
    expect(asText).toContain(`status: findings — 1 errors, 0 warnings, 0 info (examined 1 ${unit?.kind === 'report' ? unit.examined.unit : ''})`);
  });

  it('refuses to write a document its registry schema rejects', () => {
    const report = { ...reportWith(1, []), data: { bundles: 'not a list' } } as unknown as Report<typeof DATA>;

    expect(() => writeDocument(VERB, report, 'json')).toThrow();
    expect(written()).toBe('');
  });

  it('throws for a verb the registry does not know', () => {
    expect(() => writeDocument('no such verb' as typeof VERB, reportWith(1, []), 'json')).toThrow(/no such verb/);
  });
});

describe('endWithReport', () => {
  it('adds the run-integrity finding from the registry denominator and exits 1', () => {
    endWithReport(VERB, reportWith(0, []), 'json');

    const document = JSON.parse(written()) as Report<unknown>;
    expect(document.status).toBe('findings');
    expect(document.findings.map((finding) => finding.code)).toEqual(['RESOURCE_CHECK_BROKEN']);
    expect(exit.mock.calls).toEqual([[ExitCode.FINDINGS]]);
  });

  it('exits 0 on a clean report that examined something', () => {
    endWithReport(VERB, reportWith(1, []), 'yaml');

    expect((yaml.parse(written()) as Report<unknown>).status).toBe('ok');
    expect(exit.mock.calls).toEqual([[ExitCode.OK]]);
  });
});

describe('endWithRefusal', () => {
  it('endWithRefusal publishes status error with the refusal code and exits 2', () => {
    endWithRefusal(VERB, 'USAGE_INVALID', new Error('No OKF bundle named nope'), 'json', { strict: false }, NOTHING_FINISHED);

    const document = JSON.parse(written()) as ErrorReport<unknown>;
    expect(document.status).toBe('error');
    expect(document.error).toEqual({ code: 'USAGE_INVALID', message: 'No OKF bundle named nope' });
    expect(document.examined).toBe(0);
    expect(document.data).toBeNull();
    expect(exit.mock.calls).toEqual([[ExitCode.ERROR]]);
  });

  it('endWithRefusal keeps the finished work it is handed — examined, findings and data survive into the document', () => {
    const warning: Finding = { ...FINDING, severity: 'warning' };
    endWithRefusal(VERB, 'RUN_INCOMPLETE', 'stopped half way', 'yaml', { strict: true }, { examined: 3, findings: [warning], data: DATA });

    const document = yaml.parse(written()) as Report<unknown>;
    expect(document.status).toBe('error');
    expect(document.examined).toBe(3);
    expect(document.findings).toEqual([warning]);
    expect(document.summary).toEqual({ errors: 0, warnings: 1, info: 0 });
    expect(document.gate).toEqual({ strict: true });
    expect(document.data).toEqual(DATA);
    expect(exit.mock.calls).toEqual([[ExitCode.ERROR]]);
  });
});

describe('a refusal\'s diagnostics follow --debug', () => {
  afterEach(() => {
    setDebugDiagnostics(false);
  });

  it('without --debug a user\'s refusal writes its message only — no stack', () => {
    endWithRefusal(VERB, 'USAGE_INVALID', new Error('No OKF bundle named nope'), 'json', { strict: false }, NOTHING_FINISHED);

    expect(stderrText()).toBe('No OKF bundle named nope\n');
  });

  it('under --debug every refusal writes its diagnostics, naming the throw site', () => {
    setDebugDiagnostics(true);

    endWithRefusal(VERB, 'USAGE_INVALID', new Error('No OKF bundle named nope'), 'json', { strict: false }, NOTHING_FINISHED);

    expect(stderrText()).toContain('Error: No OKF bundle named nope\n    at ');
  });
});

describe('a refusal in text mode', () => {
  it('renders the error line with its code, then the status line', () => {
    endWithRefusal(VERB, 'USAGE_INVALID', new Error('No OKF bundle named nope'), 'text', { strict: false }, NOTHING_FINISHED);

    const text = written();
    expect(text).toContain('error: No OKF bundle named nope [USAGE_INVALID]');
    expect(text).toContain('status: error — 0 errors, 0 warnings, 0 info (examined 0 ');
    expect(exit.mock.calls).toEqual([[ExitCode.ERROR]]);
  });
});

describe('the other writer entry points', () => {
  it('writeExternalDocument passes the payload through and ends on the adapter\'s code', () => {
    writeExternalDocument('claude org info', { has_more: false, data: [] }, 'json', { kind: 'partial', failed: 1 });

    expect(JSON.parse(written())).toEqual({ has_more: false, data: [] });
    expect(exit.mock.calls).toEqual([[ExitCode.ERROR]]);
  });

  it('writeLegacyDocument serializes the legacy document as asked', () => {
    writeLegacyDocument('claude context', { kind: 'answer' }, 'yaml', undefined);

    // ONE document: opened with `---`, no trailing marker (which would open a second).
    expect(written().startsWith('---\n')).toBe(true);
    expect(yaml.parseAllDocuments(written())).toHaveLength(1);
    expect(yaml.parse(written())).toEqual({ kind: 'answer' });
  });

  it('a forwarded document is written byte for byte and ends on the code IT derives', () => {
    const asJson = `${JSON.stringify(reportWith(1, [FINDING]), null, 2)}\n`;
    endWithForwardedDocument(readForwardedDocument(VERB, asJson, 'json'));
    expect(written()).toBe(asJson);
    expect(exit.mock.calls).toEqual([[ExitCode.FINDINGS]]);
    stdout.mockClear();

    const asYaml = `---\n${yaml.stringify(reportWith(1, []))}`;
    expect(readForwardedDocument(VERB, asYaml, 'yaml').report.status).toBe('ok');
  });

  it('readForwardedDocument refuses a truncated or foreign document', () => {
    const full = JSON.stringify(reportWith(1, []));
    expect(() => readForwardedDocument(VERB, full.slice(0, full.length / 2), 'json')).toThrow();
    expect(() => readForwardedDocument(VERB, '---\nkind: answer\n', 'yaml')).toThrow();
    expect(written()).toBe('');
  });

  it('writeArtifact writes a raw artifact verbatim and refuses an unregistered name', () => {
    writeArtifact('claude-desktop-config', '{"mcpServers":{}}\n', 'raw');

    expect(written()).toBe('{"mcpServers":{}}\n');
    expect(() => writeArtifact('no-such-artifact', {}, 'json')).toThrow(/no-such-artifact/);
  });

  it('writeArtifactFile refuses an unregistered name before touching the disk', () => {
    expect(() => writeArtifactFile('no-such-artifact', 'never-written.json', {})).toThrow(/no-such-artifact/);
  });

  it('NOTHING_FINISHED is the explicit empty FinishedWork', () => {
    const nothing: FinishedWork = NOTHING_FINISHED;
    expect(nothing).toEqual({ examined: 0, findings: [], data: null });
  });
});
