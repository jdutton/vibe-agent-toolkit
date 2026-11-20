/**
 * `vat audit` and `vat skills validate` see the same files of the same tree.
 *
 * Audit refuses nothing it can degrade, but how a run treats an unreadable
 * file is its refusal policy only: it never picks the enumerator. Inside git
 * both verbs enumerate through git, so a committed document under a directory
 * named like tool output (`docs/coverage/`) is a member for both, and a dead
 * link in it is a finding for both. An audit that walked the filesystem with
 * the never-crawl list instead would drop the document and exit clean. Outside
 * git both verbs list one walk that prunes tool-output names, so neither sees
 * the document (the known defect "Outside a repository, authored markdown under
 * a tool-output-named directory is not enumerated"): they agree.
 *
 * Audit's listing is names only: git's `ls-files`, never a `git add --all`
 * snapshot, which hashes every untracked file and fails on one git cannot read.
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, safePath } from '@vibe-agent-toolkit/utils';
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

/** A project whose skill links to a dead link under `docs/coverage/`. */
const TREE = {
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
} as const;

/** chmod cannot lock a file on Windows, nor against root. */
const canLockFiles = process.platform !== 'win32' && process.getuid?.() !== 0;

/**
 * Run `vat <args>` in `root` under a `git` that logs each argv to a file in `tempDir`, then runs
 * the real one.
 */
async function withGitArgvLog(
  run: { binPath: string; tempDir: string; root: string },
  args: string[],
  env: Record<string, string>,
): Promise<{ parsed: Record<string, unknown>; spawned: string[] }> {
  const shim = safePath.join(run.tempDir, 'shim');
  const log = safePath.join(run.tempDir, 'git-argv.log');
  mkdirSyncReal(shim, { recursive: true });
  writeFileSync(safePath.join(shim, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${gitExecutable()}' "$@"\n`, { mode: 0o755 });
  writeFileSync(log, '');
  const { parsed } = await executeCliAndParseYaml(run.binPath, args, {
    cwd: run.root,
    env: { ...env, PATH: `${shim}:${process.env['PATH'] ?? ''}` },
  });
  return { parsed, spawned: readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0) };
}

/** The argv lines that staged the tree into an index. */
function staged(spawned: readonly string[]): string[] {
  return spawned.filter((argv) => argv.startsWith('add ') || argv.includes(' add '));
}

describe('audit and skills validate enumerate one tree the same way (system test)', () => {
  const binPath = getBinPath(import.meta.url);
  let tempDir: string;
  let root: string;
  let plain: string;

  beforeAll(() => {
    tempDir = createTestTempDir('vat-audit-parity-');
    root = safePath.join(tempDir, 'repo');
    writeFileTree(root, TREE);
    // Tracked, so git names it a member whatever its directory is called.
    spawnSync(gitExecutable(), ['init', '--quiet'], { cwd: root, stdio: 'pipe' });
    spawnSync(gitExecutable(), ['add', '--all'], { cwd: root, stdio: 'pipe' });
    // No repository above it: the temp dir is outside every checkout.
    plain = safePath.join(tempDir, 'plain');
    writeFileTree(plain, TREE);
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

  it('agrees outside git: neither verb enumerates the docs/coverage document', async () => {
    const audit = await executeCliAndParseYaml(binPath, ['audit', plain], { cwd: plain });
    const validate = await executeCliAndParseYaml(binPath, ['skills', 'validate', plain], { cwd: plain });

    expect(findingCodes(validate.parsed)).not.toContain('LINK_MISSING_TARGET');
    expect(findingCodes(audit.parsed)).not.toContain('LINK_MISSING_TARGET');
    expect(audit.result.status, audit.result.stderr).toBe(0);
    expect(validate.result.status, validate.result.stderr).toBe(0);
  });

  it.runIf(canLockFiles)('still reports the findings with an untracked file git cannot read', async () => {
    const locked = safePath.join(root, 'docs/newsecret.txt');
    writeFileSync(locked, 'secret\n');
    chmodSync(locked, 0o000);
    try {
      const audit = await executeCliAndParseYaml(binPath, ['audit', root], { cwd: root });
      expect(findingCodes(audit.parsed)).toContain('LINK_MISSING_TARGET');
      expect(audit.result.status, audit.result.stderr).toBe(1);
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  it.runIf(process.platform !== 'win32')('lists the repository by name: audit never stages it into an index', async () => {
    const { parsed, spawned } = await withGitArgvLog({ binPath, tempDir, root }, ['audit', root], {});
    expect(findingCodes(parsed)).toContain('LINK_MISSING_TARGET');
    // The premise: the shim saw audit's git calls, its listing among them.
    expect(spawned.some((argv) => argv.startsWith('ls-files')), spawned.join('\n')).toBe(true);
    // The claim: nothing staged, so no file was read or hashed by git.
    expect(staged(spawned), spawned.join('\n')).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('resources validate with the store off takes no tree snapshot', async () => {
    // With no store nothing keys the tree, so a snapshot would read and hash every untracked file for nothing.
    const { spawned } = await withGitArgvLog({ binPath, tempDir, root }, ['resources', 'validate', root], { VAT_PROJECTION_STORE: 'off' });
    expect(spawned.some((argv) => argv.startsWith('ls-files')), spawned.join('\n')).toBe(true);
    expect(staged(spawned), spawned.join('\n')).toEqual([]);
  });
});
