/**
 * `vat resources validate`, run twice against one pinned projection store,
 * gives the same answer both times — and the second run SAYS the store served
 * it.
 *
 * `data.population` is derived from `populate()`'s own outcome, never from a
 * side tell, so the only way the warm run can report `'store'` is that every
 * root's population was a hit. The fixture carries the shapes most likely to
 * make a stored extent differ from a derived one: a gitignored directory the OS
 * will not list (a condition row, not a refusal: the resources verbs refuse
 * only a NON-ignored one), a declined symlink, and a broken link, so the run
 * has findings and a non-zero exit to compare. A findings-only run writes
 * nothing to stderr, so stderr is compared whole rather than as one line.
 *
 * Isolation: `HOME`, `USERPROFILE`, `CLAUDE_CONFIG_DIR` and `TMPDIR` all point
 * into scratch, and the store directory is pinned through the variable the
 * module under test owns.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { createSymlink, mkdirSyncReal, normalizedTmpdir, safePath, symlinkCapability } from '@vibe-agent-toolkit/utils';
import { CANNOT_DENY_READS } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROJECTION_STORE_DIR_ENV } from '../../src/utils/projection-store.js';
import { commitTestFixture } from '../test-helpers.js';

import { executeCli, fakeHomeEnv, getBinPath } from './test-common.js';

const binPath = getBinPath(import.meta.url);

/** The directory the OS refuses to list. Gitignored, so the run is not refused. */
const LOCKED_DIR = 'locked';

/** Null on a host that cannot create symlinks; the suite is skipped there. */
const SYMLINKS = symlinkCapability();

let scratch: string;
let corpus: string;

interface Run {
  readonly status: number | null;
  readonly document: { readonly findings: unknown[]; readonly summary: unknown; readonly data: Record<string, unknown> };
  readonly stderr: string;
}

async function validateOnce(storeDir: string): Promise<Run> {
  const tmp = safePath.join(scratch, 'tmp');
  const result = await executeCli(binPath, ['resources', 'validate', '--format', 'json'], {
    cwd: corpus,
    env: {
      ...fakeHomeEnv(safePath.join(scratch, 'home')),
      TMPDIR: tmp,
      VAT_RESOURCES_CRAWL: 'projection',
      VAT_PROJECTION_STORE: 'sqlite',
      [PROJECTION_STORE_DIR_ENV]: storeDir,
    },
  });
  return {
    status: result.status,
    document: JSON.parse(result.stdout) as Run['document'],
    stderr: result.stderr,
  };
}

describe.skipIf(CANNOT_DENY_READS || SYMLINKS === null)(
  'vat resources validate twice against one pinned store (system test)',
  () => {
    beforeAll(() => {
      scratch = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-validate-population-'));
      mkdirSyncReal(safePath.join(scratch, 'home', '.claude'), { recursive: true });
      mkdirSyncReal(safePath.join(scratch, 'tmp'), { recursive: true });
      corpus = safePath.join(scratch, 'corpus');
      mkdirSyncReal(safePath.join(corpus, 'docs'), { recursive: true });
      mkdirSyncReal(safePath.join(corpus, LOCKED_DIR), { recursive: true });
      writeFileSync(safePath.join(corpus, '.gitignore'), `${LOCKED_DIR}/\n`, 'utf-8');
      writeFileSync(safePath.join(corpus, LOCKED_DIR, 'hidden.md'), '# Hidden\n', 'utf-8');
      writeFileSync(safePath.join(corpus, 'docs', 'one.md'), '# One\n\nSee [missing](./missing.md).\n', 'utf-8');
      writeFileSync(safePath.join(corpus, 'docs', 'two.md'), '# Two\n', 'utf-8');
      if (SYMLINKS !== null) createSymlink(SYMLINKS, 'two.md', safePath.join(corpus, 'docs', 'linked.md'));
      commitTestFixture(corpus);
      chmodSync(safePath.join(corpus, LOCKED_DIR), 0o000);
    });

    afterAll(() => {
      chmodSync(safePath.join(corpus, LOCKED_DIR), 0o755);
      rmSync(scratch, { recursive: true, force: true });
    });

    it('answers identically twice, and the second answer comes from the store', async () => {
      const storeDir = safePath.join(scratch, 'store');
      const cold = await validateOnce(storeDir);
      const warm = await validateOnce(storeDir);

      // The fixture must actually fail, or "identical" compares two empty answers.
      expect(cold.status).not.toBe(0);
      expect(cold.document.findings.length).toBeGreaterThan(0);
      expect(cold.document.summary).toBeDefined();

      expect(warm.status).toBe(cold.status);
      expect(warm.document.findings).toEqual(cold.document.findings);
      expect(warm.document.summary).toEqual(cold.document.summary);
      expect(warm.stderr).toBe(cold.stderr);

      expect(cold.document.data['population']).toBe('derived');
      expect(warm.document.data['population']).toBe('store');
    });
  },
);
