/**
 * One `vat audit` report must not contradict itself.
 *
 * Two properties are enforced here, both against ONE fixture:
 *
 *   1. Every `path` and `location` in the report is relative to the root it
 *      states — including a finding in a LINKED file, the carrier the only
 *      absolute anchors left in a real run lived on (532 of them).
 *   2. The envelope `summary`, the sum of the per-file `summary` counts, and the
 *      finding records actually present all agree. A real run disagreed three
 *      ways at once (55/422/504 header vs 55/360/405 summed), because per-file
 *      counts were producer-declared and a producer that appends findings after
 *      publishing its counts leaves them stale.
 *
 * FIXTURE REQUIREMENTS — a fixture that lacks any of these cannot distinguish
 * the fixed behaviour from the broken one, and would pass either way:
 *
 *   - a skill with LINKED markdown that itself carries findings (defect 1's
 *     only carrier, and the reason the pre-existing anchor-contract fixture —
 *     which has no linked files — was structurally blind to it);
 *   - a plugin whose validator appends findings after publishing its counts
 *     (the stale-counts producer);
 *   - info-severity records, since a header that silently drops one severity
 *     class still reconciles on the other two.
 *
 * Each requirement is asserted as a precondition, so the fixture rotting into
 * one that cannot fail is itself a failure.
 */


import fs from 'node:fs';

import { countBySeverity, type SeverityCounts } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUDIT_REPORT_SCHEMA } from '../../src/commands/audit-schema.js';
import { buildAuditReport } from '../../src/commands/audit.js';
import { anchorContractViolations, anchorsBelowRoot } from '../anchor-contract-helpers.js';
import { gitAddAll, initTestGitRepo, silentLogger } from '../test-helpers.js';

function writeFileAt(filePath: string, content: string): void {
  fs.mkdirSync(safePath.resolve(filePath, '..'), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * A skill whose findings live in a LINKED file, not in SKILL.md.
 *
 * The fenced shell block sits in `resources/shell-guide.md`, so the
 * CAPABILITY_LOCAL_SHELL observation is located in the linked file.
 * SKILL.md deliberately carries no fence of its own, so removing the link
 * removes the finding — the fixture cannot silently stop exercising the case.
 */
function writeSkillWithLinkedFinding(skillDir: string): void {
  writeFileAt(
    safePath.join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: guide-skill',
      'description: Explains how to use the guide when a reader needs the shell steps.',
      '---',
      '',
      '# Guide skill',
      '',
      'Read the [shell guide](resources/shell-guide.md) before starting.',
      '',
    ].join('\n'),
  );
  writeFileAt(
    safePath.join(skillDir, 'resources', 'shell-guide.md'),
    ['# Shell guide', '', '```bash', 'git status', '```', ''].join('\n'),
  );
}

/** A plugin manifest with no `version` and no `license` — warning + info. */
function writePluginWithStaleCounts(pluginDir: string): void {
  writeFileAt(
    safePath.join(pluginDir, '.claude-plugin', 'plugin.json'),
    `${JSON.stringify({ name: 'no-version', description: 'A plugin that omits its version.' }, null, 2)}\n`,
  );
}

const ZERO: SeverityCounts = { errors: 0, warnings: 0, info: 0 };

function addCounts(a: SeverityCounts, b: SeverityCounts): SeverityCounts {
  return {
    errors: a.errors + b.errors,
    warnings: a.warnings + b.warnings,
    info: a.info + b.info,
  };
}

function sumCounts(all: readonly SeverityCounts[]): SeverityCounts {
  return all.reduce(addCounts, ZERO);
}

describe('audit report coherence (integration)', () => {
  let tempDir: string;
  let report: Awaited<ReturnType<typeof buildAuditReport>>['report'];

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-coherence-'));
    initTestGitRepo(tempDir);
    // No vibe-agent-toolkit.config.yaml on purpose: config-aware packaging
    // validation takes another lane, and the linked-file finding below is the
    // plain validator's.
    writeSkillWithLinkedFinding(safePath.join(tempDir, 'skills', 'guide-skill'));
    writePluginWithStaleCounts(safePath.join(tempDir, 'plugins', 'no-version'));
    gitAddAll(tempDir);

    ({ report } = await buildAuditReport(tempDir, { recursive: true }, Date.now(), silentLogger));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('fixture precondition: it can distinguish fixed from broken', () => {
    // The published schema accepts it — the writer would.
    AUDIT_REPORT_SCHEMA.parse(report);
    expect(report.data.files.length).toBeGreaterThan(1);
    // Defect 1's only carrier: a finding located in the LINKED file, not SKILL.md.
    expect(report.findings.some((f) => f.location === 'skills/guide-skill/resources/shell-guide.md')).toBe(true);
    // Defect 2's stale-counts producer.
    expect(report.data.files.some((f) => f.type === 'claude-plugin' && f.status === 'findings')).toBe(true);
    // A total that drops one severity class still reconciles on the other two.
    expect(report.summary.info).toBeGreaterThan(0);
  });

  it('every path in the document is relative to the root it states', () => {
    const violations = anchorContractViolations(anchorsBelowRoot(report), report.data.root ?? '');

    expect(violations).toEqual([]);
  });

  it('the envelope summary equals the finding records actually present', () => {
    expect(report.summary).toEqual(countBySeverity(report.findings));
  });

  it('the envelope summary equals the sum of the per-file summary counts', () => {
    // Every finding belongs to exactly one file row, so counting per file and
    // counting the flattened list are the same arithmetic on the same records.
    const fromRows = sumCounts(report.data.files.map((f) => f.summary));

    expect(report.summary).toEqual(fromRows);
  });

  it('every per-file status agrees with its own summary', () => {
    const stale = report.data.files
      .filter((f) => (f.status === 'findings') !== (f.summary.errors + f.summary.warnings + f.summary.info > 0))
      .map((f) => `${f.path}: status ${f.status} over ${JSON.stringify(f.summary)}`);

    expect(stale).toEqual([]);
  });
});
