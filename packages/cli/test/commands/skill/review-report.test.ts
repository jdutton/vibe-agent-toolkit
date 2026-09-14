/**
 * The `--yaml` document of `vat skill review` is the shared report envelope.
 *
 * What is pinned: the denominator is the one skill reviewed, the findings are
 * the envelope's (once — the sections carry codes, not copies), every
 * checklist section appears whether or not a finding landed in it, and the
 * document validates against the schema the registry emits for it.
 */

import type { PackagingValidationResult } from '@vibe-agent-toolkit/agent-skills';
import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { describe, expect, it } from 'vitest';

import { CHECKLIST_SECTIONS, type ChecklistSection } from '../../../src/commands/skill/review-checklist.js';
import { buildReviewReport, SKILL_REVIEW_REPORT_SCHEMA } from '../../../src/commands/skill/review.js';

function result(allErrors: ValidationIssue[]): PackagingValidationResult {
  return {
    skillName: 'my-skill',
    status: allErrors.some((issue) => issue.severity === 'error') ? 'error' : 'success',
    allErrors,
    ignoredErrors: [],
    observations: [],
    evidence: [],
    metadata: {
      skillLines: 40,
      totalLines: 120,
      fileCount: 3,
      directFileCount: 2,
      maxLinkDepth: 1,
      excludedReferenceCount: 1,
      excludedReferences: [{ path: 'README.md', reason: 'navigation-file' }],
    },
  };
}

function grouped(entries: Partial<Record<ChecklistSection, ValidationIssue[]>>): Map<ChecklistSection, ValidationIssue[]> {
  const map = new Map<ChecklistSection, ValidationIssue[]>();
  for (const section of CHECKLIST_SECTIONS) map.set(section, entries[section] ?? []);
  return map;
}

const NAMING: ValidationIssue = { code: 'SKILL_NAME_MISMATCHES_DIR', severity: 'error', message: 'name', location: 'skills/a/SKILL.md' };
const BODY: ValidationIssue = { code: 'SKILL_LENGTH_EXCEEDS_RECOMMENDED', severity: 'warning', message: 'long', location: 'skills/a/SKILL.md' };

describe('buildReviewReport', () => {
  it('examines exactly one skill and says ok when nothing was found', () => {
    const report = buildReviewReport(result([]), 'skills/a/SKILL.md', grouped({}));

    expect(report.status).toBe('ok');
    expect(report.examined).toBe(1);
    expect(report.findings).toEqual([]);
    expect(report.data.skill).toBe('my-skill');
    expect(report.data.sections.map((row) => row.section)).toEqual([...CHECKLIST_SECTIONS]);
  });

  it('publishes each finding once, in section order, with the section naming its codes', () => {
    const report = buildReviewReport(
      result([NAMING, BODY]),
      'skills/a/SKILL.md',
      grouped({ 'Body structure': [BODY], Naming: [NAMING] }),
    );

    expect(report.status).toBe('findings');
    expect(report.summary).toEqual({ errors: 1, warnings: 1, info: 0 });
    expect(report.findings.map((finding) => finding.code)).toEqual(['SKILL_NAME_MISMATCHES_DIR', 'SKILL_LENGTH_EXCEEDS_RECOMMENDED']);
    const bySection = new Map(report.data.sections.map((row) => [row.section, row.codes]));
    expect(bySection.get('Naming')).toEqual(['SKILL_NAME_MISMATCHES_DIR']);
    expect(bySection.get('Body structure')).toEqual(['SKILL_LENGTH_EXCEEDS_RECOMMENDED']);
    expect(bySection.get('Readability')).toEqual([]);
  });

  it('validates against the schema the registry emits for it', () => {
    const report = buildReviewReport(result([NAMING]), 'skills/a/SKILL.md', grouped({ Naming: [NAMING] }));

    const parsed = SKILL_REVIEW_REPORT_SCHEMA.safeParse(report);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
  });
});
