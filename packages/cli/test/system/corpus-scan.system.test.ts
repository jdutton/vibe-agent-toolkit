/**
 * System test: `vat corpus scan` end-to-end against a real public GitHub
 * repo via HTTPS clone. Network-gated — set NET_AVAILABLE=1 to enable.
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
import * as yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import { binPath } from '../test-helpers.js';

import { executeCli } from './test-helpers/cli-runner.js';

const NET = process.env.NET_AVAILABLE === '1';

(NET ? describe : describe.skip)('vat corpus scan — system (network)', () => {
  it(
    'clones a public repo, audits it, and writes a valid summary',
    async () => {
      const workspace = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-corpus-sys-'));
      const seedPath = safePath.join(workspace, 'seed.yaml');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled path
      writeFileSync(
        seedPath,
        yaml.dump({
          plugins: [
            { source: 'https://github.com/octocat/Hello-World.git', name: 'hello-world' },
          ],
        }),
        'utf-8'
      );
      const outDir = safePath.join(workspace, 'runs');

      const result = executeCli(binPath, ['corpus', 'scan', seedPath, '--out', outDir]);
      expect(result.status).toBe(0);

      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
      const runDirs = readdirSync(outDir);
      expect(runDirs).toHaveLength(1);
      const firstRun = runDirs[0];
      if (!firstRun) throw new Error('no run dir created');
      const summaryPath = safePath.join(outDir, firstRun, 'summary.yaml');
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- test-controlled
      const summary = yaml.load(readFileSync(summaryPath, 'utf-8')) as Record<string, unknown>;
      expect((summary.plugins as unknown[]).length).toBe(1);
    },
    60_000
  );
});
