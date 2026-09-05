import { describe, expect, it } from 'vitest';

import { AllowEntrySchema, ValidationConfigSchema } from '../src/validation-config.js';
import {
  CUSTOM_CHECK_CODE_PREFIX,
  customCheckCode,
  isCustomCheckCode,
} from '../src/validation-issue.js';

describe('ValidationConfigSchema', () => {
  it('parses a minimal severity-only config', () => {
    const result = ValidationConfigSchema.safeParse({ severity: { LINK_DROPPED_BY_DEPTH: 'error' } });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown severity value', () => {
    const result = ValidationConfigSchema.safeParse({ severity: { LINK_DROPPED_BY_DEPTH: 'fatal' } });
    expect(result.success).toBe(false);
  });

  it('requires reason on allow entries', () => {
    const result = ValidationConfigSchema.safeParse({
      allow: { LINK_DROPPED_BY_DEPTH: [{ paths: ['docs/**'] }] },
    });
    expect(result.success).toBe(false);
  });

  it('allows an entry with reason and optional expires', () => {
    const result = ValidationConfigSchema.safeParse({
      allow: {
        LINK_DROPPED_BY_DEPTH: [{ paths: ['docs/**'], reason: 'ok', expires: '2026-09-30' }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('is strict — rejects unknown top-level fields', () => {
    const result = ValidationConfigSchema.safeParse({
      severity: {},
      extra: 'not allowed',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown severity code key', () => {
    const r = ValidationConfigSchema.safeParse({ severity: { LNIK_OUTSIDE_PROJECT: 'ignore' } });
    expect(r.success).toBe(false);
  });
  it("accepts 'info' as an override value", () => {
    const r = ValidationConfigSchema.safeParse({ severity: { SKILL_TIME_SENSITIVE_CONTENT: 'info' } });
    expect(r.success).toBe(true);
  });
});

describe('ValidationConfigSchema — thresholds', () => {
  it('parses a thresholds block with alwaysLoadedContextTokens', () => {
    const result = ValidationConfigSchema.safeParse({
      thresholds: { alwaysLoadedContextTokens: 12_000 },
    });
    expect(result.success).toBe(true);
  });

  it('parses a config with no thresholds key at all', () => {
    const result = ValidationConfigSchema.safeParse({ severity: {} });
    expect(result.success).toBe(true);
  });

  it('parses an empty thresholds block', () => {
    const result = ValidationConfigSchema.safeParse({ thresholds: {} });
    expect(result.success).toBe(true);
  });

  it.each([
    ['a non-integer', 12_000.5],
    ['zero', 0],
    ['a negative number', -1],
    ['a string', '12000'],
  ])('rejects %s alwaysLoadedContextTokens', (_label, value) => {
    const result = ValidationConfigSchema.safeParse({
      thresholds: { alwaysLoadedContextTokens: value },
    });
    expect(result.success).toBe(false);
  });

  it('is strict inside thresholds — rejects an unknown threshold key', () => {
    const result = ValidationConfigSchema.safeParse({
      thresholds: { alwaysLoadedContextTokens: 12_000, alwaysLoadedContextTokenz: 9 },
    });
    expect(result.success).toBe(false);
  });
});

// Proves the new code actually reached IssueCodeSchema: `severity` and `allow`
// are keyed by the registry enum, so a config naming a code the registry does not
// hold is rejected. If ALWAYS_LOADED_CONTEXT_BUDGET were missing from
// CODE_REGISTRY these two would fail exactly like the LNIK_ typo test above.
describe('ValidationConfigSchema — ALWAYS_LOADED_CONTEXT_BUDGET is an overridable code', () => {
  it('accepts a severity override for ALWAYS_LOADED_CONTEXT_BUDGET', () => {
    const result = ValidationConfigSchema.safeParse({
      severity: { ALWAYS_LOADED_CONTEXT_BUDGET: 'ignore' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts an allow entry keyed by ALWAYS_LOADED_CONTEXT_BUDGET', () => {
    const result = ValidationConfigSchema.safeParse({
      allow: {
        ALWAYS_LOADED_CONTEXT_BUDGET: [
          { paths: ['docs/**'], reason: 'docs tree is read by humans, not loaded as context' },
        ],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('AllowEntrySchema', () => {
  it('defaults paths to ["**/*"] when omitted', () => {
    const result = AllowEntrySchema.safeParse({ reason: 'whole-skill concern' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paths).toEqual(['**/*']);
    }
  });

  it('preserves explicit paths when provided', () => {
    const result = AllowEntrySchema.safeParse({ paths: ['docs/**'], reason: 'explicit scope' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.paths).toEqual(['docs/**']);
    }
  });
});

/**
 * The `CUSTOM:<name>` override namespace.
 *
 * ⚠️ This is the class of defect where FOLLOWING OUR OWN DOCUMENTATION bricked
 * every command. `vat resources check`'s help text, the `resources.checks`
 * schema description and `sql-checks.ts`'s header all told adopters that
 * `resources.validation.severity` could downgrade or ignore an inherited check
 * — and the key schema was the closed registry enum, so a config containing
 * exactly what was prescribed failed `ProjectConfigSchema` outright. That does
 * not fail `vat resources check`; it fails `loadConfigCached`, so EVERY vat
 * command exited 2 with a dump of the whole registry enum.
 *
 * Both directions are pinned below. A one-sided guard here would be worse than
 * none: accepting `CUSTOM:` by loosening the key to `z.string()` would also
 * accept every misspelled registry code, which is the typo class the enum was
 * closed to catch.
 */
/**
 * What the schema said about one bad severity key.
 *
 * Module scope rather than inside its `describe`: a test-scoped helper is a lint
 * error here (`local/no-test-scoped-functions`, SonarQube S1515).
 *
 * @param key - The key to submit
 * @returns The serialized issues, so a test can assert on the wording
 */
function refusalFor(key: string): string {
  const result = ValidationConfigSchema.safeParse({ severity: { [key]: 'ignore' } });
  expect(result.success).toBe(false);
  return result.success ? '' : JSON.stringify(result.error.issues);
}

describe('ValidationConfigSchema — the CUSTOM: override namespace', () => {
  it('accepts a severity override keyed by a custom check code', () => {
    const result = ValidationConfigSchema.safeParse({
      severity: { [customCheckCode('my-check')]: 'ignore' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a custom key alongside registry keys in one map', () => {
    // The realistic config. A map that mixes the two is what an adopter with
    // both shipped-code opinions and their own checks actually writes, and a
    // union key schema that only worked in a map of one kind would be useless.
    const result = ValidationConfigSchema.safeParse({
      severity: {
        LINK_DROPPED_BY_DEPTH: 'error',
        [customCheckCode('orphan-skills')]: 'warning',
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts every check name the checks record admits, dots and spaces included', () => {
    // `resources.checks` is `z.record(z.string(), …)`, so a check key is any
    // non-empty string. The override key space must be at least as wide, or a
    // legitimately-named check becomes un-overridable — a config the adopter
    // cannot write to silence a rule they were told they could silence.
    for (const name of ['a', 'orphan-skills', 'skills.orphans', 'no txt files', 'CUSTOM:nested']) {
      const result = ValidationConfigSchema.safeParse({
        severity: { [customCheckCode(name)]: 'ignore' },
      });
      expect(result.success, `check name ${JSON.stringify(name)} was rejected`).toBe(true);
    }
  });

  it.each([
    ['the bare prefix with no check name', 'CUSTOM:'],
    ['the wrong case', 'custom:my-check'],
    ['the prefix without its colon', 'CUSTOMmy-check'],
    ['the prefix alone', 'CUSTOM'],
    ['a misspelled registry code', 'LNIK_OUTSIDE_PROJECT'],
    ['a registry code with a custom-looking suffix', 'LINK_DROPPED_BY_DEPTH:extra'],
  ])('still rejects %s as a severity key', (_label, key) => {
    const result = ValidationConfigSchema.safeParse({ severity: { [key]: 'ignore' } });
    expect(result.success).toBe(false);
  });

  /**
   * The refusal MESSAGE, which used to send half its readers to the wrong place.
   *
   * One sentence answered every rejected key: *"a custom severity key must be
   * `CUSTOM:<name>`, naming a check declared under resources.checks"*. Two
   * things were wrong with it, and both are pinned below.
   */
  describe('the refusal message', () => {
    it('tells a NON-OVERRIDABLE code apart from a misspelled custom key', () => {
      // 🔑 An adopter who writes `RESOURCE_CHECK_BROKEN: ignore` has read three
      // docs describing that code at length. Telling them they misspelled a
      // CUSTOM key is not what happened and not what to do about it.
      const message = refusalFor('RESOURCE_CHECK_BROKEN');

      expect(message).toContain('RESOURCE_CHECK_BROKEN');
      expect(message).toContain('unsilenceable');
      // And it still points at the thing they CAN override.
      expect(message).toContain('CUSTOM:');
    });

    it('gives a registry-SHAPED typo the same reading, since the two are indistinguishable', () => {
      // `LNIK_OUTSIDE_PROJECT` and `RESOURCE_CHECK_BROKEN` are the same fact to
      // this schema — a SCREAMING_SNAKE key not in the registry — so one message
      // has to carry both readings rather than guessing.
      expect(refusalFor('LNIK_OUTSIDE_PROJECT')).toContain('misspelled registry code');
    });

    it('does NOT claim the custom name must be declared, because nothing enforces that', () => {
      // 🚨 The message used to end "naming a check declared under
      // resources.checks" and no code checked it: `isCustomCheckCode` tests the
      // prefix and nothing else, so `CUSTOM:not-a-real-check` parsed, overrode
      // nothing, and said nothing. An adopter who believes a stale override
      // would be refused stops looking for one. The guard is a run-time warning
      // in `vat resources check` now; the message must not promise it here.
      expect(refusalFor('custom:wrong-case')).not.toContain('declared under');
    });

    it('still accepts a CUSTOM: key naming no declared check — this schema cannot see them', () => {
      // The counterpart of the test above, stated as behaviour rather than as
      // wording: this schema has no access to `resources.checks`, so refusing
      // here is not available. `warnUndeclaredOverrides` is where it is caught.
      const result = ValidationConfigSchema.safeParse({
        severity: { [customCheckCode('a-check-that-does-not-exist')]: 'ignore' },
      });
      expect(result.success).toBe(true);
    });
  });

  it('rejects a custom key under `allow`, because the allow filter would ignore it', () => {
    // 🔑 A deliberate ASYMMETRY, not an oversight. `severity` reaches a check's
    // findings through `resolveIssueSeverity`, which is code-agnostic. `allow`
    // does not: the allow filter is `IssueCode`-typed and `vat resources check`
    // never runs it, so a `CUSTOM:` allow entry would parse, do nothing, and
    // report nothing — an adopter would believe a path was exempted when every
    // finding under it still failed their build.
    //
    // A loud config error is the honest answer, and this pins that the widening
    // above did not leak into the field where it would be inert.
    const result = ValidationConfigSchema.safeParse({
      allow: { [customCheckCode('my-check')]: [{ paths: ['docs/**'], reason: 'legacy tree' }] },
    });
    expect(result.success).toBe(false);
  });
});

describe('customCheckCode', () => {
  it('is the ONE definition of the custom code shape', () => {
    // The minter and the acceptor must agree by construction, not by two
    // regexes that happen to match today. `isCustomCheckCode` is what the key
    // schema above refines with, so this is the whole agreement.
    expect(customCheckCode('my-check')).toBe('CUSTOM:my-check');
    expect(isCustomCheckCode(customCheckCode('my-check'))).toBe(true);
    expect(isCustomCheckCode(CUSTOM_CHECK_CODE_PREFIX)).toBe(false);
  });
});
