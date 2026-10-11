/**
 * System test: `vat corpus scan` end-to-end — over local sources (always), and
 * against a real public GitHub repo via HTTPS clone (network-gated — set
 * NET_AVAILABLE=1 to enable).
 *
 * Uses GitHub's canonical Hello-World demo repo for stability:
 * https://github.com/octocat/Hello-World
 *
 * The audited repo isn't a real plugin, so the scan may classify it as
 * unloadable or produce warnings. The test only verifies that the scan
 * ran end-to-end and wrote a valid summary.yaml.
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';
import * as yaml from 'yaml';

import { CORPUS_SCAN_REPORT_SCHEMA } from '../../src/commands/corpus/scan-schema.js';
import { useScratchTmpdir } from '../helpers/scratch-tmpdir.js';
import { binPath } from '../test-helpers.js';

import { writeFileTree } from './test-common.js';
import { executeCli } from './test-helpers/cli-runner.js';

// ⛔ Disposal paths: TMPDIR / TEMP / TMP point at a scratch tree for every test, and every `vat`
// child it spawns inherits them, so neither the run nor a mutation of its cleanup can reach the real temp dir.
useScratchTmpdir('vat-scratch-cli-5-');

const NET = process.env.NET_AVAILABLE === '1';

const META = {
  bucket: 'official',
  confidence: 'first-party',
  maturity: 'production',
} as const;

/** A SKILL.md nothing complains about. */
const CLEAN_SKILL = '---\nname: clean\ndescription: Reviews widgets for quality. Use when a reviewer wants a '
  + 'checklist walkthrough of a widget in depth.\n---\n\n# clean\n\nPurpose statement goes here.\n';

/** Write a seed of `sources` (name → source path) into a fresh workspace, and scan it. */
function scanLocal(sources: Readonly<Record<string, string>>, files: Readonly<Record<string, string>> = {}): { status: number | null; stdout: string; workspace: string } {
  const workspace = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-local-'));
  writeFileTree(workspace, files);
  const plugins = Object.entries(sources).map(([name, source]) => ({ source: safePath.join(workspace, source), name, ...META }));
  const seedPath = safePath.join(workspace, 'seed.yaml');
  writeFileSync(seedPath, yaml.stringify({ plugins }), 'utf-8');
  const result = executeCli(binPath, ['corpus', 'scan', seedPath, '--out', safePath.join(workspace, 'runs')]);
  return { status: result.status, stdout: result.stdout, workspace };
}

describe('vat corpus scan — system (local sources)', () => {
  it('publishes the report on stdout: one row per seed entry, the run dir in data', () => {
    const { status, stdout, workspace } = scanLocal({ plugin: 'plugin' }, { 'plugin/skills/clean/SKILL.md': CLEAN_SKILL });

    const report = CORPUS_SCAN_REPORT_SCHEMA.parse(yaml.parse(stdout));
    expect(status).toBe(0);
    expect(report.status).toBe('ok');
    expect(report.examined).toBe(1);
    if (report.status === 'error') throw new Error('unreachable');
    expect(report.data.outDir).toBe(safePath.join(workspace, 'runs'));
    expect(report.data.entries).toHaveLength(1);
    const [entry] = report.data.entries;
    expect(entry).toMatchObject({ name: 'plugin', review: 'skipped' });
    expect(entry?.outputPath).toMatch(/^\d{4}-\d{2}-\d{2}-[^/]+\/plugin-audit\.yaml$/);
  }, 60_000);

  it('reports an entry it could not audit as a finding, and still exits 0', () => {
    const { status, stdout } = scanLocal({ gone: 'never-created' });

    const report = CORPUS_SCAN_REPORT_SCHEMA.parse(yaml.parse(stdout));
    expect(report.status).toBe('findings');
    expect(report.findings).toEqual([expect.objectContaining({ code: 'CORPUS_ENTRY_INCOMPLETE', severity: 'warning' })]);
    if (report.status === 'error') throw new Error('unreachable');
    expect(report.data.entries).toEqual([{ name: 'gone', audit: 'unloadable', review: 'skipped', outputPath: null }]);
    expect(status).toBe(0);
  }, 60_000);
});

(NET ? describe : describe.skip)('vat corpus scan — system (network)', () => {
  it(
    'clones a public repo, audits it, and writes a valid summary',
    async () => {
      const workspace = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-sys-'));
      const seedPath = safePath.join(workspace, 'seed.yaml');
      writeFileSync(
        seedPath,
        yaml.stringify({
          plugins: [
            { source: 'https://github.com/octocat/Hello-World.git', name: 'hello-world', ...META },
          ],
        }),
        'utf-8'
      );
      const outDir = safePath.join(workspace, 'runs');

      const result = executeCli(binPath, ['corpus', 'scan', seedPath, '--out', outDir]);
      expect(result.status).toBe(0);

      const runDirs = readdirSync(outDir);
      expect(runDirs).toHaveLength(1);
      const firstRun = runDirs[0];
      if (!firstRun) throw new Error('no run dir created');
      const summaryPath = safePath.join(outDir, firstRun, 'summary.yaml');
      const summary = yaml.parse(readFileSync(summaryPath, 'utf-8')) as Record<string, unknown>;
      expect(summary.plugins as unknown[]).toHaveLength(1);
    },
    60_000
  );
});
