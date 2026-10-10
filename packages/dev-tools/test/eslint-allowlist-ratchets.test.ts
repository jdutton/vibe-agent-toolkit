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
 * drift from it. The rules here are syntactic (an import is an import,
 * a `process.exit(2)` is a literal), so a bare parser and only that rule
 * answer the question in a fraction of a typed program's time; the type-aware
 * `NO_UNSAFE_BACKLOG` ratchet is the same shape in
 * `test/integration/no-unsafe-backlog-ratchet.integration.test.ts`.
 */

import tsparser from '@typescript-eslint/parser';
import { compareCodeUnits, resolveFromImportMeta } from '@vibe-agent-toolkit/utils';
import localRules from '@vibe-agent-toolkit/utils/eslint';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

import { filesWithoutFinding } from './eslint-clean-files.js';

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..');

/** A repo-relative path that names one source file: no trailing `/`, a script extension. */
const SOURCE_FILE = /^[^*]+\.[cm]?[jt]s$/u;

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
    rule: 'local/no-existssync',
    option: 'allowFiles',
    probeFile: 'packages/cli/src/commands/doctor.ts',
    constant: 'NO_EXISTSSYNC_RATCHET',
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
  {
    rule: 'local/no-stdout-outside-writer',
    option: 'allowFiles',
    probeFile: 'packages/cli/src/commands/okf/validate.ts',
    constant: 'STDOUT_OUTSIDE_WRITER_ALLOW',
  },
];

/** The options object the repo's own config hands the rule, or `{}`. */
async function configuredOptions(ratchet: Ratchet): Promise<Readonly<Record<string, unknown>>> {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const config = await eslint.calculateConfigForFile(`${REPO_ROOT}/${ratchet.probeFile}`);
  const entry = config.rules?.[ratchet.rule] as [number, Record<string, unknown>?] | undefined;
  return entry?.[1] ?? {};
}

/** The list the repo's own config hands the rule, or `[]`. */
async function configuredList(ratchet: Ratchet): Promise<readonly string[]> {
  return ((await configuredOptions(ratchet))[ratchet.option] as readonly string[] | undefined) ?? [];
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
      // `.cts` too: a CommonJS-TypeScript source file can sit on a list (`no-existssync`).
      files: ['**/*.ts', '**/*.cts'],
      languageOptions: { parser: tsparser, parserOptions: { ecmaVersion: 2024, sourceType: 'module' } },
      plugins: { local: localRules },
      // The repo's own options with ONLY the list lifted: a rule whose other
      // options are required (`no-stdout-outside-writer`'s `paths`) keeps them.
      rules: { [ratchet.rule]: ['error', { ...(await configuredOptions(ratchet)), [ratchet.option]: [] }] },
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

  it('names source files, never a directory, in sorted order', async () => {
    const list = await configuredList(ratchet);
    // A directory entry would exempt every file under it, and none of them could ever be delisted.
    expect(list.filter((entry) => !SOURCE_FILE.test(entry)), 'entries that do not name one source file').toEqual([]);
    // Sorted (code-unit order), so an entry has one place and a duplicate or a near-duplicate sits beside its twin.
    expect(list, `${ratchet.constant} is not sorted`).toEqual(list.toSorted(compareCodeUnits));
  });

  it('every listed file still trips the rule — remove the entry when it does not', async () => {
    expect(
      await cleanWithoutExemption(ratchet, await configuredList(ratchet)),
      `These files no longer trip ${ratchet.rule}. Delete their entries from ${ratchet.constant} `
        + 'in eslint.config.js — the list may only shrink, and a stale entry hides the next offender.',
    ).toEqual([]);
  });
});
