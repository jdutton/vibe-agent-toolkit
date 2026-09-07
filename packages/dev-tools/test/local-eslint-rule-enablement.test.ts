/**
 * The rules this repo enables ONLY in its own `eslint.config.js` — and nothing
 * else was reading that file.
 *
 * ## The gap this closes
 *
 * `packages/utils/eslint` ships a rule pack, and `configs.recommended` is a
 * deliberately smaller set: eight rules are excluded from it because they depend
 * on a fact about the CONSUMER (their Node floor, their package layout, their
 * decoding seam) rather than a fact that holds everywhere. That exclusion is
 * itself pinned — `packages/utils/test/eslint/rules.test.ts` asserts the exact
 * excluded set — so those eight reach this repo's own source through exactly one
 * artifact: a severity line in the root `eslint.config.js`.
 *
 * Deleting such a line is invisible. Every unit test still passes (they exercise
 * the rule MODULE, through `RuleTester`, which never consults a project config),
 * `bun run lint` still exits 0 (a rule that is off reports nothing), and the diff
 * is one deleted line inside a 40-entry object literal.
 *
 * This repo has been here before. `no-fragile-entrypoint-guard` exists because
 * three prose `⛔ NOT import.meta.main` banners stood over three call sites and
 * reverting all three to the bug left the suite green — a banner addressed to a
 * human is not a mechanism. The rule replaced the banners; its own ENABLEMENT
 * then became the unread artifact, one level up. This file is the mechanism for
 * the mechanism.
 *
 * ## Why the RESOLVED config and not the file's text
 *
 * Grepping `eslint.config.js` for the rule name is the weakest available form
 * and would pass on every one of these:
 *
 * - the name appearing only in a prose comment (this file's own subject appears
 *   in three comments there),
 * - the severity downgraded from `'error'` to `'warn'` or `'off'`,
 * - the entry present but inside a `files:` block that matches nothing,
 * - a later config object turning the rule back off for the whole tree,
 * - the `local` namespace renamed, which silently unbinds every entry at once.
 *
 * `ESLint#calculateConfigForFile` asks the resolver the question that actually
 * matters — *for this real source file, on disk, what severity does ESLint apply
 * to this rule?* — and answers it after flat config's cascade has been applied.
 * It is the same code path `bun run lint` takes.
 *
 * ## Why the rule list is DERIVED
 *
 * Hardcoding `no-fragile-entrypoint-guard` would leave its seven siblings in the
 * same unpinned state and would rot the moment the pack grows. So the set under
 * test is computed: every rule the pack ships, minus every rule
 * `configs.recommended` already carries. A new rule added to the pack and left
 * out of `recommended` lands in that set automatically, and this test then fails
 * until someone states where in this repo it applies — which is the decision
 * that would otherwise be skipped.
 */

import { resolveFromImportMeta } from '@vibe-agent-toolkit/utils';
import localRules from '@vibe-agent-toolkit/utils/eslint';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

/** The repo root, where `eslint.config.js` lives. */
const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..');

/**
 * Any compiled source answers for the five rules declared repo-wide, and this
 * one is also under `packages/utils/src/**`, which is where the two
 * package-scoped blocks apply. One file therefore covers seven of the eight.
 */
const REPO_WIDE_PROBE = 'packages/utils/src/entrypoint.ts';

/**
 * A real file each rule is meant to govern.
 *
 * Five of the eight are declared repo-wide, so any compiled source answers for
 * them; `no-unsafe-root-join` is deliberately scoped to the skill-test staging
 * code and needs a file from there. The map is keyed by rule name and its key
 * set is asserted against the derived exclusion set below, so a new excluded
 * rule cannot be answered by silence — someone has to name the surface it
 * guards, which is the only part of this a human should be doing.
 */
const PROBE_FILES: Readonly<Record<string, string>> = {
  'no-bare-symlink-in-tests': REPO_WIDE_PROBE,
  'no-fragile-entrypoint-guard': REPO_WIDE_PROBE,
  'no-process-exit-in-phase': REPO_WIDE_PROBE,
  'no-raw-text-decode': REPO_WIDE_PROBE,
  'no-self-package-import': REPO_WIDE_PROBE,
  'no-test-scoped-functions': REPO_WIDE_PROBE,
  // Deliberately scoped to the skill-test staging code, so it needs its own.
  'no-unsafe-root-join': 'packages/utils/src/skill-test/spawn-claude.ts',
  'require-justified-skip': REPO_WIDE_PROBE,
};

/** `error` as ESLint normalizes it out of `calculateConfigForFile`. */
const ERROR = 2;

/** Rule ids are `<namespace>/<name>`; the namespace is not a path. */
function bareName(ruleId: string): string {
  return ruleId.slice(ruleId.lastIndexOf('/') + 1);
}

/**
 * Every rule the pack ships that `configs.recommended` does NOT carry — i.e.
 * every rule whose only route into this repo's source is the root config.
 */
function locallyEnabledOnlyRules(): string[] {
  const recommended = new Set(
    Object.keys(localRules.configs.recommended.rules).map((id) => bareName(id)),
  );
  return Object.keys(localRules.rules)
    .filter((name) => !recommended.has(name))
    .sort((a, b) => a.localeCompare(b));
}

describe('local ESLint rules excluded from `recommended` are enabled in this repo', () => {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const derived = locallyEnabledOnlyRules();

  it('names a probe file for every rule `recommended` excludes, and no others', () => {
    // Fails on ADDING a rule to the pack, which is the point: a new excluded
    // rule is exactly when someone has to decide which surface it governs here.
    expect(Object.keys(PROBE_FILES).sort((a, b) => a.localeCompare(b))).toEqual(derived);
  });

  it.each(derived)('`local/%s` resolves to error for the file it governs', async (name) => {
    const probe = PROBE_FILES[name];
    // The case above already pins the key set; this is the narrowing that lets
    // the path be used, and a louder failure than `undefined` in a path string.
    if (probe === undefined) throw new Error(`no probe file declared for ${name}`);

    const config = await eslint.calculateConfigForFile(`${REPO_ROOT}/${probe}`);
    const severity = config.rules?.[`local/${name}`]?.[0];

    expect(
      severity,
      `local/${name} is not enabled at error for ${probe}. Only this repo's own `
        + 'eslint.config.js turns it on — `configs.recommended` excludes it — so if '
        + 'that line is gone, the rule is dead everywhere and nothing else notices.',
    ).toBe(ERROR);
  });
});
