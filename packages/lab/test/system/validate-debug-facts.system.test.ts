/**
 * The debug-facts dump has two contracts: the cli's writer (`validate-debug-facts.ts`) and the
 * lab's strict reader (`ValidateDebugFactsSchema`). Neither package depends on the other, so this
 * is where they meet: the BUILT vat runs `validate` on a committed subject, cold and then warm,
 * with `VAT_VALIDATE_DEBUG_FACTS` set, and every dump it writes must parse under the lab's schema.
 * A field renamed on either side fails here.
 *
 * System-tier: real git, the built vat, its own store, home and dump directories.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, describe, expect, it } from 'vitest';

import { ValidateDebugFactsSchema } from '../../src/facets/perf/types.js';
import { cleanupVerdictFixtures, tempDir } from '../integration/verdict-fixtures.js';

import { CANDIDATE_VAT, cleanSubject } from './candidate-subject.js';

afterAll(cleanupVerdictFixtures);

/** A bound on one vat run, so a hang fails the case instead of blocking the worker. */
const RUN_TIMEOUT_MS = 60_000;

/** The parent environment without any VAT_ setting, so the run is this test's alone. */
function isolatedEnv(overrides: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('VAT_')) env[key] = value;
  return { ...env, ...overrides };
}

/**
 * Run the built `vat validate` in `root` and read the one dump it wrote.
 *
 * @param root - The subject
 * @param cacheDir - The store, shared by the cold and warm run
 * @returns The exit code and the dump's parsed JSON
 */
function validateWithFacts(root: string, cacheDir: string): { status: number | null; dumps: unknown[] } {
  const factsDir = tempDir('lab-debug-facts-');
  const home = tempDir('lab-debug-facts-home-');
  const result = spawnSync(CANDIDATE_VAT.command, [...CANDIDATE_VAT.leadingArgs, 'validate'], {
    cwd: root,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: isolatedEnv({
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: safePath.join(home, '.claude'),
      VAT_CACHE_DIR: cacheDir,
      VAT_VALIDATE_DEBUG_FACTS: factsDir,
    }),
  });
  if (result.error !== undefined) throw result.error;
  const dumps = readdirSync(factsDir).map((name) => JSON.parse(readFileSync(safePath.join(factsDir, name), 'utf8')) as unknown);
  return { status: result.status, dumps };
}

describe('vat validate debug facts', () => {
  it('writes one dump per run that the lab\'s strict schema reads, cold and warm', () => {
    const root = cleanSubject();
    const cacheDir = tempDir('lab-debug-facts-store-');

    for (const run of [validateWithFacts(root, cacheDir), validateWithFacts(root, cacheDir)]) {
      expect(run.status).toBe(0);
      expect(run.dumps).toHaveLength(1);
      const parsed = ValidateDebugFactsSchema.safeParse(run.dumps[0]);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });
});
