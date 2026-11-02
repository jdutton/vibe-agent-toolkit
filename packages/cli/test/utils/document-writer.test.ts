/**
 * The one document writer: renders a registered verb's report in the operator's
 * format, derives the run-integrity refusal from the registry's denominator,
 * validates against the published schema before a byte leaves, and ends on the
 * code the written document derives.
 */

import { buildErrorReport, buildReport, ExitCode, type ErrorReport, type Finding, type Report } from '@vibe-agent-toolkit/schema';
import { recordSuppressedFault } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import yaml from 'yaml';

import { PUBLISHED_SHAPES } from '../../src/report-schemas.js';
import { CommandRefusalError } from '../../src/utils/command-refusal.js';
import { setDebugDiagnostics } from '../../src/utils/debug-diagnostics.js';
import {
  announceErrorOf,
  endWithLeftoverRefusal,
  endWithRefusal,
  endWithReport,
  endWithForwardedDocument,
  leftoverIssue,
  leftoverIssuesOfWarnings,
  readForwardedDocument,
  NOTHING_FINISHED,
  publishedReport,
  writeArtifact,
  writeArtifactFile,
  writeDocument,
  writeExternalDocument,
  writeLegacyDocument,
  type FinishedWork,
} from '../../src/utils/document-writer.js';
import { reportFindings } from '../../src/utils/issue-rendering.js';
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

  it('says the refusal it adds on stderr exactly once, through the shared finding line', () => {
    endWithReport(VERB, reportWith(0, []), 'yaml');

    expect(stderrText().match(/Nothing was examined/g)).toHaveLength(1);
    expect(stderrText()).toMatch(/error: Nothing was examined: 0 bundle documents\. .*\[RESOURCE_CHECK_BROKEN\]/);
  });

  it('leaves the refusal to stdout under --format text when the default rendering carries every finding', () => {
    endWithReport(VERB, reportWith(0, []), 'text');

    expect(written()).toContain('Nothing was examined');
    expect(stderrText()).not.toContain('Nothing was examined');
  });

  it('says it on stderr under --format text when the verb\'s own rendering carries no finding', () => {
    endWithReport('ard emit', buildReport({ examined: 0, findings: [], data: { outputPath: null, entryCount: 0, skippedCount: 0, shadowedCount: 0 }, gate: { strict: false } }), 'text');

    expect(stderrText().match(/Nothing was examined/g)).toHaveLength(1);
  });

  it('says nothing for a report that already carries a refusal — the writer added none', () => {
    endWithReport(VERB, publishedReport(VERB, reportWith(0, [])), 'json');

    expect(stderrText()).toBe('');
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

  it('says the finished work\'s findings on stderr once, through the shared reporter', () => {
    endWithRefusal(VERB, 'INPUT_UNREADABLE', 'one root unreadable', 'yaml', { strict: false }, { examined: 1, findings: [FINDING], data: DATA });

    expect(stderrText().split(`[${FINDING.code}]`)).toHaveLength(2);
    expect(stderrText()).toContain(`  bundles/knowledge/a.md:1: error: concept has no type [${FINDING.code}]\n`);
  });

  it('says the refusal first, then the finished work\'s findings', () => {
    endWithRefusal(VERB, 'INPUT_UNREADABLE', 'one root unreadable', 'yaml', { strict: false }, { examined: 1, findings: [FINDING], data: DATA });

    const text = stderrText();
    expect(text.indexOf('one root unreadable')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('one root unreadable')).toBeLessThan(text.indexOf(`[${FINDING.code}]`));
  });

  it('leaves them to stdout under the generic --format text rendering', () => {
    endWithRefusal(VERB, 'INPUT_UNREADABLE', 'one root unreadable', 'text', { strict: false }, { examined: 1, findings: [FINDING], data: DATA });

    expect(stderrText()).not.toContain(FINDING.code);
  });
});

/**
 * A refusal always says why on stderr — whichever entry point published it, exactly once. An error
 * report a verb builds itself (`buildErrorReport`) and publishes through `endWithReport` used to
 * print nothing at all: only `endWithRefusal`'s composer said a message.
 */
describe('an error report says its message on stderr exactly once', () => {
  const MESSAGE = 'the population did not complete';
  const errorReport = (): Report<unknown> => buildErrorReport({
    error: { code: 'RUN_INCOMPLETE', message: MESSAGE },
    gate: { strict: false },
    examined: 0,
    findings: [],
    data: DATA,
  });
  const occurrences = (text: string): number => text.split(MESSAGE).length - 1;

  it.each(['yaml', 'json', 'text'] as const)('endWithReport, --format %s', (format) => {
    endWithReport(VERB, errorReport(), format);

    expect(occurrences(stderrText())).toBe(1);
    expect(exit.mock.calls).toEqual([[ExitCode.ERROR]]);
  });

  it('endWithRefusal says it once, not again in the writer', () => {
    endWithRefusal(VERB, 'RUN_INCOMPLETE', MESSAGE, 'json', { strict: false }, NOTHING_FINISHED);

    expect(occurrences(stderrText())).toBe(1);
  });

  it('a forwarded error document is said by the process that publishes it, before its leftovers', () => {
    const LEFT = 'could not remove the log';
    const report = publishedReport(VERB, buildErrorReport({
      error: { code: 'RUN_INCOMPLETE', message: MESSAGE }, gate: { strict: false }, examined: 0, findings: [leftoverIssue(LEFT, undefined)], data: DATA,
    }));
    endWithForwardedDocument(readForwardedDocument(VERB, JSON.stringify(report), 'json'));

    const text = stderrText();
    expect(occurrences(text)).toBe(1);
    expect(text.indexOf(MESSAGE)).toBeLessThan(text.indexOf(LEFT));
  });

  it('announceErrorOf says one report once, however often it is asked', () => {
    const report = errorReport();
    announceErrorOf(report);
    announceErrorOf(report);
    writeDocument(VERB, report, 'json');

    expect(occurrences(stderrText())).toBe(1);
  });
});

describe('endWithLeftoverRefusal', () => {
  const LEFTOVER = 'could not delete /tmp/parked-entry';

  it('says the leftover once — as the refusal — and still publishes it as a warning after the finished findings', () => {
    endWithLeftoverRefusal(VERB, new CommandRefusalError('RUN_INCOMPLETE', LEFTOVER), 'yaml', { strict: false }, { examined: 1, findings: [FINDING], data: DATA });

    const text = stderrText();
    expect(text.split(LEFTOVER)).toHaveLength(2);
    expect(text.indexOf(LEFTOVER)).toBeLessThan(text.indexOf(`[${FINDING.code}]`));
    const document = yaml.parse(written()) as ErrorReport<unknown>;
    expect(document.status).toBe('error');
    expect(document.error).toEqual({ code: 'RUN_INCOMPLETE', message: LEFTOVER });
    expect(document.findings.map((finding) => [finding.code, finding.severity, finding.message])).toEqual([
      [FINDING.code, 'error', FINDING.message],
      ['TREE_CLEANUP_INCOMPLETE', 'warning', LEFTOVER],
    ]);
    expect(exit.mock.calls).toEqual([[ExitCode.ERROR]]);
  });
});

describe('a leftover is said by the writer that publishes it', () => {
  const LEFT = 'could not remove the previous build';
  const LEFT_LINE = `warning: ${LEFT} [TREE_CLEANUP_INCOMPLETE]`;
  const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

  it('builds a finished change\'s leftovers as warnings, and says nothing while building them', () => {
    const findings = leftoverIssuesOfWarnings([{ code: 'TREE_CLEANUP_INCOMPLETE', path: '/tmp/parked-build', message: LEFT }]);

    expect(findings).toEqual([expect.objectContaining({ code: 'TREE_CLEANUP_INCOMPLETE', severity: 'warning', message: LEFT, link: '/tmp/parked-build' })]);
    expect(stderrText()).toBe('');
  });

  it('says every leftover a success document carries on stderr, exactly once, with its fix', () => {
    writeDocument(VERB, reportWith(1, [FINDING, leftoverIssue(LEFT, '/tmp/parked-build')]), 'yaml');

    const text = stderrText();
    expect(occurrences(text, LEFT_LINE)).toBe(1);
    expect(text).toContain('Fix: Remove what the message names');
    // Only the leftover: the verb's other findings are the verb's to say.
    expect(text).not.toContain(FINDING.code);
  });

  it('says it under json too, and not when stdout is the generic text rendering that already lists it', () => {
    writeDocument(VERB, reportWith(1, [leftoverIssue(LEFT, undefined)]), 'json');
    expect(occurrences(stderrText(), LEFT_LINE)).toBe(1);

    vi.mocked(process.stderr.write).mockClear();
    writeDocument(VERB, reportWith(1, [leftoverIssue(LEFT, undefined)]), 'text');
    expect(stderrText()).not.toContain(LEFT_LINE);
    expect(written()).toContain(LEFT_LINE);
  });

  it('a refusal says its message, then the finished findings, then each leftover once — finished or suppressed', () => {
    const error = new CommandRefusalError('INPUT_UNREADABLE', 'the run was refused');
    recordSuppressedFault(error, new Error('could not remove the staged tree'));
    endWithRefusal(VERB, 'INPUT_UNREADABLE', error, 'yaml', { strict: false }, { examined: 1, findings: [FINDING, leftoverIssue(LEFT, undefined)], data: DATA });

    const text = stderrText();
    expect(occurrences(text, LEFT_LINE)).toBe(1);
    expect(occurrences(text, 'could not remove the staged tree [TREE_CLEANUP_INCOMPLETE]')).toBe(1);
    expect(text.indexOf('the run was refused')).toBeLessThan(text.indexOf(`[${FINDING.code}]`));
    expect(text.indexOf(`[${FINDING.code}]`)).toBeLessThan(text.indexOf(LEFT_LINE));
  });

  it('a forwarded document\'s leftovers are said by the process that publishes it', () => {
    const report = publishedReport(VERB, reportWith(1, [leftoverIssue(LEFT, undefined)]));
    endWithForwardedDocument(readForwardedDocument(VERB, JSON.stringify(report), 'json'));

    expect(occurrences(stderrText(), LEFT_LINE)).toBe(1);
  });

  it('the shared reporter never says a leftover, so no verb can say one twice', () => {
    const lines: string[] = [];
    reportFindings([FINDING, leftoverIssue(LEFT, undefined)], { verbose: true, write: (line) => lines.push(line) });

    expect(lines.join('\n')).toContain(FINDING.code);
    expect(lines.join('\n')).not.toContain('TREE_CLEANUP_INCOMPLETE');
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

  it('writeExternalDocument says each leftover its payload carries, once, and no other warning', () => {
    const left = leftoverIssue('the download directory could not be removed', '/tmp/vat-org-skills-x');
    const other = { code: 'SOMETHING_ELSE', severity: 'warning', message: 'not a leftover' };
    writeExternalDocument('claude org skills install', { skills: [], warnings: [left, other] }, 'yaml', { kind: 'ok' });

    const said = stderrText();
    expect(said.split('the download directory could not be removed').length - 1).toBe(1);
    expect(said).not.toContain('not a leftover');
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
