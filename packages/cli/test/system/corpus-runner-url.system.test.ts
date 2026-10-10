/**
 * `auditOnePlugin` over a URL source: the runner shallow-clones a real bare
 * repository with git — a spawned process — so these cases live in the system tier. The
 * local-source and pure cases stay in `test/commands/corpus/runner.test.ts`.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { gitExecutable } from '@vibe-agent-toolkit/utils/testing';
import { describe, expect, it, vi } from 'vitest';
import * as yaml from 'yaml';

import { AUDIT_REPORT_SCHEMA } from '../../src/commands/audit-schema.js';
import type * as Audit from '../../src/commands/audit.js';
import { auditOnePlugin } from '../../src/commands/corpus/runner.js';
import type { PluginEntry } from '../../src/commands/corpus/seed.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';

// ⛔ Disposal paths: TMPDIR / TEMP / TMP point at a scratch tree for every test, and every `vat`
// child it spawns inherits them, so neither the run nor a mutation of its cleanup can reach the real temp dir.
useScratchTmpdir('vat-scratch-cli-4-');

/** The in-process audit, made to throw by one case; every other call runs the real one. */
const { auditSpy } = vi.hoisted(() => ({ auditSpy: vi.fn() }));
vi.mock('../../src/commands/audit.js', async (importOriginal) => {
  const real = await importOriginal<typeof Audit>();
  auditSpy.mockImplementation(real.getValidationResults);
  return { ...real, getValidationResults: auditSpy };
});

const URL_META = { bucket: 'official', confidence: 'first-party', maturity: 'production' } as const;
const NOT_DEBUG = { withReview: false, debug: false, leftovers: [] };

function freshRunDir(): string {
  return mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-url-rundir-'));
}

function git(args: string[], cwd: string): void {
  const r = spawnSync(gitExecutable(), args, { cwd, encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** A bare repository on `main` holding `plugins/foo/SKILL.md`. */
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
  writeFileSync(
    safePath.join(skillDir, 'SKILL.md'),
    `---\nname: foo\ndescription: A test skill for the URL-source runner test that exercises shallow clone end to end.\n---\n\n# foo\n\nBody.\n`,
    'utf-8'
  );

  git(['add', '.'], work);
  git(['commit', '-m', 'initial'], work);
  git(['push', 'origin', 'main'], work);
  return bare;
}

describe('auditOnePlugin — URL source (integration)', () => {
  it('clones a file:// URL, audits, and cleans up', async () => {
    const runDir = freshRunDir();
    const entry: PluginEntry = { source: pathToFileURL(makeBareRepoWithSkill()).href, name: 'foo', ...URL_META };

    const row = await auditOnePlugin(entry, { runDir, ...NOT_DEBUG });

    expect(row.audit.status).toBe('ok');
    expect(row.audit.output_path).toBe('foo-audit.yaml');
    // A cloned source's root is a random tempdir: the document names the URL instead.
    const document = AUDIT_REPORT_SCHEMA.parse(yaml.parse(readFileSync(safePath.join(runDir, 'foo-audit.yaml'), 'utf-8')));
    expect(document.data.root).toBeNull();
    expect(document.data.provenance?.url).toBe(entry.source);
    expect(document.data.files.map((file) => file.path)).toStrictEqual(['plugins/foo/SKILL.md']);
  });

  it('records unloadable when the clone fails (bad URL)', async () => {
    const entry: PluginEntry = { source: 'file:///absolutely/does/not/exist/repo.git', name: 'ghost', ...URL_META };

    const row = await auditOnePlugin(entry, { runDir: freshRunDir(), ...NOT_DEBUG });

    expect(row.audit.status).toBe('unloadable');
    expect(row.audit.error).toMatch(/clone failed|fatal|repository|not appear/i);
  });

  // An uncoded throw from a validator is a VAT defect, not a property of the plugin: it must end
  // the scan loudly, never become an unloadable row at exit 0 — past the clone lane's own catch too.
  it('lets a defect inside the audit through, past the clone lane\'s own catch', async () => {
    const thrown = new TypeError('validator defect');
    auditSpy.mockRejectedValueOnce(thrown);
    const entry: PluginEntry = { source: pathToFileURL(makeBareRepoWithSkill()).href, name: 'url-defect', ...URL_META };

    await expect(auditOnePlugin(entry, { runDir: freshRunDir(), ...NOT_DEBUG })).rejects.toBe(thrown);
  });
});
