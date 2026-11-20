/**
 * `vat audit` and `vat skills validate` see the same files of the same tree.
 *
 * Audit refuses nothing it can degrade, but how a run treats an unreadable
 * file is its refusal policy only: it never picks the enumerator. Inside git
 * both verbs enumerate through git, so a committed document under a directory
 * named like tool output (`docs/coverage/`) is a member for both, and a dead
 * link in it is a finding for both. An audit that walked the filesystem with
 * the never-crawl list instead would drop the document and exit clean.
 */

import { spawnSync } from 'node:child_process';

import { safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  cleanupTestTempDir,
  createTestTempDir,
  executeCliAndParseYaml,
  getBinPath,
  writeFileTree,
} from './test-common.js';

/** The codes a published document's findings carry, sorted. */
function findingCodes(parsed: Record<string, unknown>): string[] {
  const findings = (parsed['findings'] ?? []) as Array<{ code?: unknown }>;
  return findings.map((finding) => String(finding.code)).sort((left, right) => left.localeCompare(right));
}

describe('audit and skills validate enumerate one tree the same way (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  let tempDir: string;
  let root: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-audit-parity-');
    root = safePath.join(tempDir, 'repo');
    writeFileTree(root, {
      'vibe-agent-toolkit.config.yaml': 'skills:\n  include:\n    - skills/**/SKILL.md\n',
      'skills/s1/SKILL.md': [
        '---',
        'name: s1',
        'description: A skill that links into a directory named like tool output for testing.',
        '---',
        '# S1',
        '',
        'See [the coverage notes](../../docs/coverage/report.md).',
        '',
      ].join('\n'),
      'docs/coverage/report.md': '# Coverage\n\nSee [gone](./missing.md).\n',
    });
    // Tracked, so git names it a member whatever its directory is called.
    spawnSync(gitExecutable(), ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
    spawnSync(gitExecutable(), ['add', '--all'], { cwd: root, stdio: 'pipe' });
  });

  afterAll(() => {
    cleanupTestTempDir(tempDir);
  });

  it('reports the dead link in a tracked docs/coverage document from both verbs', async () => {
    const audit = await executeCliAndParseYaml(binPath, ['audit', root], { cwd: root });
    const validate = await executeCliAndParseYaml(binPath, ['skills', 'validate', root], { cwd: root });

    // The premise: skills validate, enumerating through git, sees the document.
    expect(findingCodes(validate.parsed)).toContain('LINK_MISSING_TARGET');
    // The claim: audit sees the same file, so it reports the same finding.
    expect(findingCodes(audit.parsed)).toContain('LINK_MISSING_TARGET');
    expect(audit.result.status, audit.result.stderr).toBe(1);
  });
});
