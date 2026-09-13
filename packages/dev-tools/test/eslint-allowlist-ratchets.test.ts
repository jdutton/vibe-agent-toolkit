/**
 * Every ESLint allowlist ratchet in `eslint.config.js`, asserted from the side
 * the rule cannot see.
 *
 * A rule exempts every file on its list, so a listed file that becomes clean
 * is invisible to `bun run lint`: the entry stays, the list looks as long as
 * the day it was seeded, and the ratchet's only promise — that the number
 * falls as the work is done — silently lapses. Two of three lists had drifted
 * that way before this table existed (`content-cache.test.ts` and
 * `external-link-cache.test.ts` were clean under `no-io-in-unit-tier` for
 * hours while listed). This test lints each listed file with the exemption
 * REMOVED and requires the rule to fire, so a clean file fails here until its
 * entry is deleted. The other direction (an unlisted file offending) is the
 * gate itself.
 *
 * One row per list. Each is read from the RESOLVED config rather than from a
 * second copy here, so there is one owner of the fact and this test cannot
 * drift from it. The three rules here are syntactic (an import is an import,
 * a `process.exit(2)` is a literal), so a bare parser and only that rule
 * answer the question in a fraction of a typed program's time; the type-aware
 * `NO_UNSAFE_BACKLOG` ratchet is the same shape in
 * `test/integration/no-unsafe-backlog-ratchet.integration.test.ts`.
 */

import tsparser from '@typescript-eslint/parser';
import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils';
import localRules from '@vibe-agent-toolkit/utils/eslint';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { filesWithoutFinding } from './eslint-clean-files.js';

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..');

interface Ratchet {
  /** The rule whose option carries the list. */
  readonly rule: string;
  /** The option key holding the repo-relative file list. */
  readonly option: 'allowFiles' | 'allow';
  /** A file the rule is configured for, so `calculateConfigForFile` resolves its options. */
  readonly probeFile: string;
  /** The constant in `eslint.config.js` a stale entry is deleted from. */
  readonly constant: string;
}

const RATCHETS: readonly Ratchet[] = [
  {
    rule: 'local/commands-import-boundary',
    option: 'allowFiles',
    probeFile: 'packages/cli/src/commands/doctor.ts',
    constant: 'COMMANDS_IMPORT_BOUNDARY_RATCHET',
  },
  {
    rule: 'local/no-io-in-unit-tier',
    option: 'allowFiles',
    probeFile: 'packages/utils/test/fs-utils.test.ts',
    constant: 'UNIT_TIER_IO_RATCHET',
  },
  {
    rule: 'local/no-literal-process-exit',
    option: 'allow',
    probeFile: 'packages/cli/src/bin.ts',
    constant: "the `allow` list on 'local/no-literal-process-exit'",
  },
];

/** The list the repo's own config hands the rule, or `[]`. */
async function configuredList(ratchet: Ratchet): Promise<readonly string[]> {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const config = await eslint.calculateConfigForFile(`${REPO_ROOT}/${ratchet.probeFile}`);
  const entry = config.rules?.[ratchet.rule] as [number, Record<string, readonly string[]>?] | undefined;
  return entry?.[1]?.[ratchet.option] ?? [];
}

/**
 * Lint the listed files with the ratchet lifted, in ONE pass, and return the
 * ones the rule stays silent on.
 */
async function cleanWithoutExemption(ratchet: Ratchet, files: readonly string[]): Promise<string[]> {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*.ts'],
      languageOptions: { parser: tsparser, parserOptions: { ecmaVersion: 2024, sourceType: 'module' } },
      plugins: { local: localRules },
      rules: { [ratchet.rule]: ['error', { [ratchet.option]: [] }] },
    }],
  });
  return filesWithoutFinding(eslint, REPO_ROOT, files, (m) => m.ruleId === ratchet.rule);
}

describe.each(RATCHETS)('$rule — its allowlist only names files that still need it', (ratchet) => {
  it('is non-empty while the backlog exists', async () => {
    // A seeded ratchet that resolves to nothing means the option was dropped
    // or renamed, and every entry would then be vacuously "clean".
    expect((await configuredList(ratchet)).length).toBeGreaterThan(0);
  });

  it('every listed file still trips the rule — remove the entry when it does not', async () => {
    expect(
      await cleanWithoutExemption(ratchet, await configuredList(ratchet)),
      `These files no longer trip ${ratchet.rule}. Delete their entries from ${ratchet.constant} `
        + 'in eslint.config.js — the list may only shrink, and a stale entry hides the next offender.',
    ).toEqual([]);
  });
});
