import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { auditOnePlugin } from '../../../src/commands/corpus/runner.js';
import type { PluginEntry } from '../../../src/commands/corpus/seed.js';

const RUN_DIR_PREFIX = 'vat-corpus-rundir-';

function makeRunDir(): string {
  return mkdtempSync(safePath.join(normalizedTmpdir(), RUN_DIR_PREFIX));
}

function makePluginDir(skillBody: string): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-runner-'));
  const skillDir = safePath.join(root, 'plugins', 'foo');
  mkdirSyncReal(skillDir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- composed test fixture path
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---\nname: foo\ndescription: ${skillBody}\n---\n\n# foo\n\nBody.\n`,
    'utf-8'
  );
  return root;
}

/**
 * Create a plugin directory with SKILL.md at the root — the shape `vat skill
 * review` expects (a single skill directory, not a multi-skill plugin tree).
 * Used by --with-review tests where the runner subprocesses `vat skill review`
 * against the plugin source directly.
 */
function makeReviewablePluginDir(name: string, skillBody: string): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-review-'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- composed test fixture path
  writeFileSync(
    safePath.join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${skillBody}\n---\n\n# ${name}\n\nBody.\n`,
    'utf-8'
  );
  return root;
}

describe('auditOnePlugin — local source', () => {
  it('returns a PluginRow with status success when the plugin audits cleanly', async () => {
    const pluginDir = makePluginDir(
      'A simple test skill that demonstrates a working SKILL.md frontmatter for the runner unit test.'
    );
    const runDir = makeRunDir();

    const entry: PluginEntry = { source: pluginDir, name: 'foo' };

    const row = await auditOnePlugin(entry, { runDir, withReview: false, debug: false });

    expect(row.source).toBe(pluginDir);
    expect(row.name).toBe('foo');
    expect(row.validation_applied).toBe(false);
    expect(row.audit.status).toBe('success');
    expect(row.audit.output_path).toBe('foo-audit.yaml');
    expect(row.review.status).toBe('skipped');
  });

  it('records unloadable when the local source path does not exist', async () => {
    const runDir = makeRunDir();
    const entry: PluginEntry = { source: '/absolutely/does/not/exist', name: 'ghost' };

    const row = await auditOnePlugin(entry, { runDir, withReview: false, debug: false });

    expect(row.audit.status).toBe('unloadable');
    expect(row.audit.error).toMatch(/not found|does not exist/i);
    expect(row.audit.output_path).toBeUndefined();
  });
});

function git(args: string[], cwd: string): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard system command
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

function makeBareRepoWithSkill(): string {
  const bare = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-bare-'));
  const work = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-work-'));

  git(['init', '--bare', '--initial-branch=main'], bare);
  git(['init', '--initial-branch=main'], work);
  git(['config', 'user.email', 't@t'], work);
  git(['config', 'user.name', 't'], work);
  git(['remote', 'add', 'origin', bare], work);

  const skillDir = safePath.join(work, 'plugins', 'foo');
  mkdirSyncReal(skillDir, { recursive: true });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- composed test fixture path
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---\nname: foo\ndescription: A test skill for the URL-source runner unit test that exercises shallow clone end to end.\n---\n\n# foo\n\nBody.\n`,
    'utf-8'
  );

  git(['add', '.'], work);
  git(['commit', '-m', 'initial'], work);
  git(['push', 'origin', 'main'], work);
  return bare;
}

describe('auditOnePlugin — URL source', () => {
  it('clones a file:// URL, audits, and cleans up', async () => {
    const bare = makeBareRepoWithSkill();
    const runDir = makeRunDir();

    const entry: PluginEntry = { source: `file://${bare}`, name: 'foo' };
    const row = await auditOnePlugin(entry, { runDir, withReview: false, debug: false });

    expect(row.audit.status).toBe('success');
    expect(row.audit.output_path).toBe('foo-audit.yaml');
  });

  it('records unloadable when the clone fails (bad URL)', async () => {
    const runDir = makeRunDir();
    const entry: PluginEntry = {
      source: 'file:///absolutely/does/not/exist/repo.git',
      name: 'ghost',
    };

    const row = await auditOnePlugin(entry, { runDir, withReview: false, debug: false });

    expect(row.audit.status).toBe('unloadable');
    expect(row.audit.error).toMatch(/clone failed|fatal|repository|not appear/i);
  });
});

describe('auditOnePlugin — validation overlay', () => {
  it('writes skills.defaults.validation into the audit target before audit runs', async () => {
    // Use a local plugin so we can inspect the overlay file post-audit.
    // Audit runs in-process so the file remains after auditOnePlugin returns
    // (cleanup is only for cloned tempdirs).
    const pluginDir = makePluginDir(
      'Skill that triggers a known warning we will silence via the validation overlay block.'
    );
    const runDir = makeRunDir();

    const entry: PluginEntry = {
      source: pluginDir,
      name: 'overlay',
      validation: {
        severity: { LINK_TO_NAVIGATION_FILE: 'ignore' },
      },
    };

    const row = await auditOnePlugin(entry, { runDir, withReview: false, debug: false });

    expect(row.validation_applied).toBe(true);

    const overlayPath = safePath.join(pluginDir, 'vibe-agent-toolkit.config.yaml');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
    const written = yaml.load(readFileSync(overlayPath, 'utf-8')) as Record<string, unknown>;
    expect((written.skills as Record<string, unknown>).defaults).toEqual({
      validation: { severity: { LINK_TO_NAVIGATION_FILE: 'ignore' } },
    });
  });

  it('does not write an overlay when validation is omitted', async () => {
    const pluginDir = makePluginDir(
      'Skill that triggers no warnings; no validation overlay should be written by the runner.'
    );
    const runDir = makeRunDir();

    const entry: PluginEntry = { source: pluginDir, name: 'no-overlay' };

    const row = await auditOnePlugin(entry, { runDir, withReview: false, debug: false });

    expect(row.validation_applied).toBe(false);
    const overlayPath = safePath.join(pluginDir, 'vibe-agent-toolkit.config.yaml');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
    expect(existsSync(overlayPath)).toBe(false);
  });
});

function makeMultiSkillPluginDir(skillNames: string[]): string {
  const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-multiskill-'));
  for (const name of skillNames) {
    const skillDir = safePath.join(root, 'plugins', name);
    mkdirSyncReal(skillDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- composed test fixture path
    writeFileSync(
      safePath.join(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Multi-skill plugin tree fixture skill ${name} that exercises the per-skill review enumeration code path.\n---\n\n# ${name}\n\nBody.\n`,
      'utf-8'
    );
  }
  return root;
}

describe('auditOnePlugin — --with-review', () => {
  it('writes an aggregated review.md and records review.status=ok when withReview is true', async () => {
    // Single-skill plugin tree: SKILL.md at the root. The runner now discovers
    // SKILL.md via discovery.scan() and reviews each skill directory, then
    // wraps results in an aggregated markdown file.
    const pluginDir = makeReviewablePluginDir(
      'reviewed',
      'Skill that runs the review pipeline end-to-end so the runner test exercises the with-review path.'
    );
    const runDir = makeRunDir();

    const entry: PluginEntry = { source: pluginDir, name: 'reviewed' };

    const row = await auditOnePlugin(entry, { runDir, withReview: true, debug: false });

    expect(row.review.status).toBe('ok');
    expect(row.review.output_path).toBe('reviewed-review.md');
    const reviewPath = safePath.join(runDir, 'reviewed-review.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
    expect(existsSync(reviewPath)).toBe(true);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
    const contents = readFileSync(reviewPath, 'utf-8');
    expect(contents).toContain('# Skill review: reviewed');
    expect(contents).toContain('Reviewed 1 of 1 skills');
    expect(contents).toContain('## SKILL.md');
  });

  it('reviews every SKILL.md in a multi-skill plugin tree', async () => {
    const pluginDir = makeMultiSkillPluginDir(['alpha', 'beta']);
    const runDir = makeRunDir();

    const entry: PluginEntry = { source: pluginDir, name: 'multi' };

    const row = await auditOnePlugin(entry, { runDir, withReview: true, debug: false });

    expect(row.review.status).toBe('ok');
    expect(row.review.output_path).toBe('multi-review.md');
    const reviewPath = safePath.join(runDir, 'multi-review.md');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
    const contents = toForwardSlash(readFileSync(reviewPath, 'utf-8'));
    expect(contents).toContain('Reviewed 2 of 2 skills');
    expect(contents).toContain('## plugins/alpha/SKILL.md');
    expect(contents).toContain('## plugins/beta/SKILL.md');
  });

  it('records review.status=error when no SKILL.md is found under the source', async () => {
    // Audit succeeds (empty tree audits cleanly) but review has nothing to do.
    const root = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-empty-'));
    const runDir = makeRunDir();

    const entry: PluginEntry = { source: root, name: 'empty' };

    const row = await auditOnePlugin(entry, { runDir, withReview: true, debug: false });

    expect(row.audit.status).not.toBe('unloadable');
    expect(row.review.status).toBe('error');
    expect(row.review.error).toMatch(/No SKILL\.md/i);
  });

  it('records review.status=skipped when audit was unloadable', async () => {
    const runDir = makeRunDir();
    const entry: PluginEntry = { source: '/does/not/exist', name: 'ghost' };

    const row = await auditOnePlugin(entry, { runDir, withReview: true, debug: false });

    // Audit is unloadable so review is skipped (don't review what didn't audit)
    expect(row.audit.status).toBe('unloadable');
    expect(row.review.status).toBe('skipped');
  });
});
