/**
 * The one not-admitted contract every crawling verb reports through: one code
 * and sentence per file, resolved through `resources.validation` like any other
 * finding, counted whatever it resolves to, and scoped to a collection by the
 * collection's own patterns.
 */

import { createRegistryIssue } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  type NotAdmittedLog,
  notAdmittedCount,
  notAdmittedFindings,
  notAdmittedInScope,
  notAdmittedIssues,
  parseRefusedEntry,
  resolveNotAdmittedAmong,
} from '../src/not-admitted.js';
import { ParseLimitError } from '../src/parse-limits.js';

const ROOT = safePath.resolve('/srv/project');
const WORDING = { locationRoot: ROOT, consequence: 'it is not in the index' };

const LOG: NotAdmittedLog = {
  unreadable: [
    { filePath: safePath.join(ROOT, 'docs/bad.md'), reason: `EACCES: permission denied, open '${ROOT}/docs/bad.md'`, code: 'EACCES' },
  ],
  parseRefused: [parseRefusedEntry(safePath.join(ROOT, 'notes/deep.md'), new ParseLimitError('outputDepth', 1000, 1001))],
};

describe('notAdmittedIssues', () => {
  it('maps nothing to nothing', () => {
    expect(notAdmittedIssues({ unreadable: [], parseRefused: [] }, WORDING)).toStrictEqual([]);
  });

  it('names each file once, relative to the root, under its own code and the verb consequence', () => {
    const issues = notAdmittedIssues(LOG, WORDING);

    expect(issues.map((issue) => [issue.code, issue.severity, issue.location])).toStrictEqual([
      ['RESOURCE_UNREADABLE', 'error', 'docs/bad.md'],
      ['RESOURCE_PARSE_LIMIT_EXCEEDED', 'error', 'notes/deep.md'],
    ]);
    for (const issue of issues) expect(issue.message).toContain('so it is not in the index');
    expect(issues[0]?.message).toContain('(EACCES)');
    // The raw fs message embeds the absolute path: never reported.
    expect(issues[0]?.message).not.toContain(ROOT);
    expect(issues[1]?.message).toContain('outputDepth');
  });
});

describe('notAdmittedFindings', () => {
  it('resolves each finding through the project severity, as every other finding is', () => {
    const findings = notAdmittedFindings(LOG, WORDING, { severity: { RESOURCE_PARSE_LIMIT_EXCEEDED: 'warning' } });

    expect(findings.map((finding) => [finding.code, finding.severity])).toStrictEqual([
      ['RESOURCE_UNREADABLE', 'error'],
      ['RESOURCE_PARSE_LIMIT_EXCEEDED', 'warning'],
    ]);
  });

  it('drops a finding the project ignores, while the count still holds the file', () => {
    const findings = notAdmittedFindings(LOG, WORDING, { severity: { RESOURCE_UNREADABLE: 'ignore' } });

    expect(findings.map((finding) => finding.code)).toStrictEqual(['RESOURCE_PARSE_LIMIT_EXCEEDED']);
    expect(notAdmittedCount(LOG)).toBe(2);
  });
});

describe('notAdmittedInScope', () => {
  it('is the whole log when no collection is named', () => {
    expect(notAdmittedInScope(LOG, undefined)).toBe(LOG);
  });

  it('keeps only the files the collection patterns match', () => {
    const notes = notAdmittedInScope(LOG, { include: ['notes/**/*.md'] });
    const docs = notAdmittedInScope(LOG, { include: ['docs/**/*.md'] });

    expect(notAdmittedCount(notes)).toBe(1);
    expect(notes.parseRefused).toHaveLength(1);
    expect(notAdmittedCount(docs)).toBe(1);
    expect(docs.unreadable).toHaveLength(1);
  });
});

describe('resolveNotAdmittedAmong', () => {
  // A report located against a SUBDIRECTORY of the project whose config it resolves under.
  const DOCS = safePath.join(ROOT, 'docs');
  const ROOTS = { locationRoot: DOCS, projectRoot: ROOT };
  const other = createRegistryIssue('LINK_MISSING_TARGET', 'a broken link', { location: 'a.md' });
  const refused = notAdmittedIssues(
    { unreadable: LOG.unreadable, parseRefused: [parseRefusedEntry(safePath.join(DOCS, 'deep.md'), new ParseLimitError('outputDepth', 1000, 1001))] },
    { locationRoot: DOCS, consequence: 'it was not audited' },
  );

  it('leaves every finding outside the not-admitted codes untouched, in place', () => {
    const resolved = resolveNotAdmittedAmong([other, ...refused], { allow: { LINK_MISSING_TARGET: [{ paths: ['docs/a.md'], reason: 'r' }] } }, ROOTS);

    expect(resolved[0]).toBe(other);
    expect(resolved).toHaveLength(3);
  });

  it('excuses one allowed at its PROJECT-relative path, and keeps the rest located as reported', () => {
    const resolved = resolveNotAdmittedAmong(refused, { allow: { RESOURCE_UNREADABLE: [{ paths: ['docs/bad.md'], reason: 'r' }] } }, ROOTS);

    expect(resolved.map((issue) => [issue.code, issue.location])).toStrictEqual([['RESOURCE_PARSE_LIMIT_EXCEEDED', 'deep.md']]);
  });

  it('resolves their severity through the project config', () => {
    const resolved = resolveNotAdmittedAmong(refused, { severity: { RESOURCE_PARSE_LIMIT_EXCEEDED: 'warning' } }, ROOTS);

    expect(resolved.map((issue) => issue.severity)).toStrictEqual(['error', 'warning']);
  });
});
