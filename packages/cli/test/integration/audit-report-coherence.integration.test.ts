/**
 * One `vat audit` document must not contradict itself.
 *
 * Two properties are enforced here, both against ONE fixture:
 *
 *   1. Every `path` in the document is relative to the root the document
 *      states — including the paths inside `files[].linkedFiles[]`, which were
 *      the only absolute anchors left in a real run (532 of them).
 *   2. The header `issueCounts`, the sum of the per-file `issueCounts`, and the
 *      issue records actually present all agree. A real run disagreed three
 *      ways at once (55/422/504 header vs 55/360/405 summed), because per-file
 *      counts are producer-declared and a producer that appends findings after
 *      publishing its counts leaves them stale.
 *
 * FIXTURE REQUIREMENTS — a fixture that lacks any of these cannot distinguish
 * the fixed behaviour from the broken one, and would pass either way:
 *
 *   - a skill with LINKED markdown that itself carries findings (defect 1's
 *     only carrier, and the reason the pre-existing anchor-contract fixture —
 *     which has no linked files — was structurally blind to it);
 *   - a plugin whose validator publishes `status` + `summary` but not
 *     `issueCounts` (the stale-counts producer);
 *   - info-severity records, since a header that silently drops one severity
 *     class still reconciles on the other two.
 *
 * Each requirement is asserted as a precondition, so the fixture rotting into
 * one that cannot fail is itself a failure.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

import fs from 'node:fs';

import { countBySeverity, type SeverityCounts, type ValidationIssue } from '@vibe-agent-toolkit/schema';
import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
 * CAPABILITY_LOCAL_SHELL observation is attached to a `linkedFiles[]` entry.
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

/** Identity of a finding, for asking whether two lists hold the same records. */
function issueKey(issue: ValidationIssue): string {
  return `${issue.code}|${issue.severity}|${issue.location ?? ''}`;
}

describe('audit report coherence (integration)', () => {
  let tempDir: string;
  let document: Awaited<ReturnType<typeof buildAuditReport>>['document'];

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-audit-coherence-'));
    initTestGitRepo(tempDir);
    // No vibe-agent-toolkit.config.yaml on purpose: config-aware packaging
    // validation does not publish `linkedFiles`, so a config here would remove
    // the very carrier defect 1 lives on.
    writeSkillWithLinkedFinding(safePath.join(tempDir, 'skills', 'guide-skill'));
    writePluginWithStaleCounts(safePath.join(tempDir, 'plugins', 'no-version'));
    gitAddAll(tempDir);

    ({ document } = await buildAuditReport(tempDir, { recursive: true }, Date.now(), silentLogger));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('fixture precondition: it can distinguish fixed from broken', () => {
    const linkedIssues = document.files.flatMap((f) => f.linkedFiles ?? []).flatMap((lf) => lf.issues);

    expect(document.files.length).toBeGreaterThan(1);
    // Defect 1's only carrier.
    expect(linkedIssues.length).toBeGreaterThan(0);
    // Defect 2's stale-counts producer.
    expect(document.files.some((f) => f.type === 'claude-plugin' && f.issues.length > 0)).toBe(true);
    // A header that drops one severity class still reconciles on the other two.
    expect(document.issueCounts.info).toBeGreaterThan(0);
  });

  it('every path in the document is relative to the root it states', () => {
    const violations = anchorContractViolations(anchorsBelowRoot(document), document.root);

    expect(violations).toEqual([]);
  });

  it('the header issueCounts equal the issue records actually present', () => {
    const fromRecords = sumCounts(document.files.map((f) => countBySeverity(f.issues)));

    expect(document.issueCounts).toEqual(fromRecords);
  });

  it('the header issueCounts equal the sum of the per-file issueCounts', () => {
    const fromDeclared = sumCounts(document.files.map((f) => f.issueCounts));

    expect(document.issueCounts).toEqual(fromDeclared);
  });

  it('every per-file issueCounts describes that file’s own issue list', () => {
    const stale = document.files
      .filter((f) => JSON.stringify(f.issueCounts) !== JSON.stringify(countBySeverity(f.issues)))
      .map((f) => `${f.path}: declared ${JSON.stringify(f.issueCounts)} vs actual ${JSON.stringify(countBySeverity(f.issues))}`);

    expect(stale).toEqual([]);
  });

  it('linked-file findings are a view of the owner’s issues, never extra records', () => {
    // This is what licenses counting each finding exactly once. If a linked
    // finding were ever absent from its owner's list, counting per-file issues
    // would under-report and the totals above would be reconciling on a set
    // that is missing records the document displays.
    const missing: string[] = [];
    for (const file of document.files) {
      const owned = new Set(file.issues.map(issueKey));
      for (const linked of file.linkedFiles ?? []) {
        for (const issue of linked.issues) {
          if (!owned.has(issueKey(issue))) missing.push(`${file.path} → ${linked.path}: ${issueKey(issue)}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
