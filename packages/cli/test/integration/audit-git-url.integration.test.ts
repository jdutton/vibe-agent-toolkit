/* eslint-disable security/detect-non-literal-fs-filename -- Test code with temp directories */

/**
 * Integration test: `vat audit <git-url>` end-to-end against a local
 * bare git repo. Avoids network entirely — bare repo created in
 * test setup, cloned by the audit pipeline like any remote.
 */

import { spawnSync } from 'node:child_process';
import fs, { mkdtempSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runAuditCli } from '../test-helpers.js';

let bareRepo: string;
let bareRepoUrl: string;
let workTree: string;

/**
 * Distinctive path segment the shorthand test rewrites github.com to. Nothing
 * of this name exists, so the clone fails immediately and offline.
 */
const OFFLINE_REMOTE_PREFIX = 'vat-offline-no-such-remote';

function git(args: string[], cwd: string): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard system command
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr ?? ''}`);
  }
}

beforeAll(() => {
  // Create a bare repo (origin) and a worktree we use to populate it.
  // Note: prefix is `vat-integ-` rather than `vat-audit-` so the cleanup
  // tests in Task 10 can count only the clones VAT creates, not these
  // fixture directories.
  bareRepo = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-integ-bare-'));
  // file:// URL for the bare repo — `isGitUrl` dispatches URLs only, not
  // absolute filesystem paths. `git clone` accepts file:// natively.
  bareRepoUrl = pathToFileURL(bareRepo).href;
  workTree = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-integ-work-'));

  // `--initial-branch=main` so HEAD points to a branch we'll actually push.
  // Without it, Ubuntu CI runners (init.defaultBranch=master) leave HEAD
  // dangling at refs/heads/master, and `git clone --single-branch` against
  // such a bare repo produces an empty working tree where `rev-parse HEAD`
  // fails — the audit then exits 2 via handleCommandError.
  git(['init', '--bare', '--initial-branch=main'], bareRepo);
  git(['init', '--initial-branch=main'], workTree);
  git(['config', 'user.email', 'test@example.com'], workTree);
  git(['config', 'user.name', 'Test'], workTree);
  git(['remote', 'add', 'origin', bareRepo], workTree);

  // Populate a SKILL.md
  const skillDir = safePath.join(workTree, 'plugins', 'foo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---
name: foo
description: A simple test skill that demonstrates a working SKILL.md frontmatter for audit-git-url integration coverage.
---

# foo

Body.
`
  );

  git(['add', '.'], workTree);
  git(['commit', '-m', 'initial'], workTree);
  git(['tag', 'v1.0.0'], workTree);
  git(['push', 'origin', 'main', '--tags'], workTree);
});

afterAll(() => {
  fs.rmSync(bareRepo, { recursive: true, force: true });
  fs.rmSync(workTree, { recursive: true, force: true });
});

describe('vat audit <git-url> — happy path', () => {
  it('clones a local bare repo, audits, and emits provenance + repo-relative paths', () => {
    const result = runAuditCli(bareRepoUrl);

    expect(result.status).toBe(0);
    // Provenance header is emitted as a YAML comment so downstream
    // tools (yq/jq) can pipe-parse the rest of the audit output.
    expect(result.stdout).toMatch(/^# Audited: .+ @ HEAD \(commit [a-f0-9]{8}\)$/m);
    // Path appears as repo-relative, not tempdir-relative.
    expect(result.stdout).toContain('plugins/foo/SKILL.md');
    expect(result.stdout).not.toMatch(/\/vat-audit-/);
  });
});

describe('vat audit <git-url> — ref pinning', () => {
  it('clones at a specific tag', () => {
    const result = runAuditCli(`${bareRepoUrl}#v1.0.0`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('@ v1.0.0');
  });

  it('reports a clear error when the ref is not found', () => {
    const result = runAuditCli(`${bareRepoUrl}#nonexistent-ref`);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Reference not found|Clone failed/);
  });
});

describe('vat audit <git-url> — subpath', () => {
  it('audits only the subpath when specified', () => {
    const result = runAuditCli(`${bareRepoUrl}#main:plugins/foo`);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('# Subpath: plugins/foo');
  });

  it('reports clearly when subpath is missing', () => {
    const result = runAuditCli(`${bareRepoUrl}#main:does/not/exist`);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/Subpath not found/);
  });

  it('rejects subpaths that escape the cloned repo via path traversal', () => {
    // `..` segments would resolve outside the tempdir — must be rejected
    // before the audit is allowed to run, regardless of whether the
    // resolved target happens to exist on the host filesystem.
    const result = runAuditCli(`${bareRepoUrl}#main:../../../etc`);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/escapes|traversal|outside/i);
  });
});

// `withClonedRepo` calls `mkdtempSync(..., 'vat-audit-')`, which appends
// exactly 6 random chars. Other fixtures in the tree use longer
// `vat-audit-<slug>-<random>` forms — exclude them with an exact match
// so we count only the directories this pipeline creates.
const cloneDirPattern = /^vat-audit-[A-Za-z0-9]{6}$/;

function countVatAuditDirs(): number {
  const tmp = normalizedTmpdir();
  return readdirSync(tmp).filter((n) => cloneDirPattern.test(n)).length;
}

describe('vat audit <git-url> — cleanup', () => {
  it('cleans up the tempdir on success', () => {
    const before = countVatAuditDirs();
    const result = runAuditCli(bareRepoUrl);
    expect(result.status).toBe(0);
    expect(countVatAuditDirs()).toBe(before);
  });

  it('cleans up the tempdir on failure (bad ref)', () => {
    const before = countVatAuditDirs();
    runAuditCli(`${bareRepoUrl}#nonexistent-ref`);
    expect(countVatAuditDirs()).toBe(before);
  });

  it('preserves the tempdir under --debug and prints its location', () => {
    const before = countVatAuditDirs();
    const result = runAuditCli(bareRepoUrl, ['--debug']);
    expect(result.status).toBe(0);
    expect(countVatAuditDirs()).toBe(before + 1);
    expect(result.stderr).toMatch(/temp dir preserved: .*vat-audit-/);

    // Capture the preserved path from stderr and clean it up so subsequent
    // tests see a clean count. We do NOT touch other vat-audit-* dirs
    // that may exist from concurrent runs.
    const match = /temp dir preserved: (\S+)/.exec(result.stderr);
    if (match) {
      fs.rmSync(match[1], { recursive: true, force: true });
    }
  });
});

describe('vat audit <path> vs <git-url> — a local path always wins', () => {
  // `isGitUrl` accepts bare `owner/repo` GitHub shorthand, and the audit
  // command used to consult it BEFORE asking whether the argument names a
  // directory on disk. Every two-segment relative path (`plugins/foo`,
  // `docs/guides`, `packages/cli`) therefore resolved to
  // https://github.com/<that>.git — the audit never ran, and the command
  // reached out to github.com with a name derived from the user's local
  // directory layout. Shorthand is only a fallback for arguments that name
  // nothing locally.
  it('audits a two-segment relative path locally instead of cloning it as owner/repo', () => {
    const result = runAuditCli('plugins/foo', [], { cwd: workTree });

    expect(result.stderr).not.toContain('Clone failed');
    expect(`${result.stdout}${result.stderr}`).not.toContain('github.com');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('SKILL.md');
  });

  it('still treats owner/repo shorthand as a URL when nothing of that name exists locally', () => {
    // Shorthand always parses to https://github.com/<owner>/<repo>.git, so a
    // naive version of this test contacts github.com — which this suite's
    // header promises it never does. Worse, github.com answers a nonexistent
    // repo with a credential challenge, and a Windows runner's credential
    // manager sits on that until VAT's own 60s wall-clock cap fires.
    //
    // Rewrite the github.com prefix to a path that cannot exist, so the clone
    // fails locally and instantly. `GIT_CONFIG_*` is git's env-only config
    // channel (git >= 2.31): it reaches the CLI's spawned git without writing
    // to any real config file.
    const result = runAuditCli('no-such-owner/no-such-repo-xyz', [], {
      cwd: workTree,
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: `url.file:///${OFFLINE_REMOTE_PREFIX}/.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/',
      },
    });

    // Reaches the clone path (and fails there) rather than being resolved as a
    // local directory. Asserted via VAT's own wrapper message, NOT git's error
    // text, which varies by platform and git version.
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('Clone failed');
    // The rewritten prefix appearing in git's message proves two things at
    // once: the argument really was routed down the URL branch, and the
    // rewrite fired (so nothing left the machine).
    expect(output).toContain(OFFLINE_REMOTE_PREFIX);
  });
});
