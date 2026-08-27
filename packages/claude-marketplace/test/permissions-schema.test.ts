/**
 * `permissions.defaultMode` reads someone else's file, so it must not be a closed set.
 *
 * `.claude/rules/schema-strictness.md`: reading external data is the LIBERAL half of
 * Postel's Law. A closed `z.enum` here is a promise that Anthropic will never add a
 * permission mode — and they do. `settings-reader.ts` THROWS on a validation failure
 * rather than degrading, so one unknown mode string takes out `vat`'s whole settings
 * audit on a settings file Claude Code itself accepts.
 */

import { describe, expect, it } from 'vitest';

import { PermissionsConfigSchema } from '../src/schemas/permissions.js';

describe('PermissionsConfigSchema.defaultMode accepts modes this build has never heard of', () => {
  // Not a list to maintain — the point is that ANY string is accepted. `plan` and
  // `auto` are here because both are real and both were rejected: the enum was
  // written before either shipped, which is the whole failure mode.
  it.each(['default', 'acceptEdits', 'plan', 'auto', 'a-mode-invented-next-year'])(
    'accepts defaultMode %s',
    (defaultMode) => {
      const result = PermissionsConfigSchema.safeParse({ defaultMode });
      expect(result.success).toBe(true);
    }
  );

  // A non-string is still a bug in the file, not a mode we have not met.
  it('still rejects a defaultMode that is not a string', () => {
    expect(PermissionsConfigSchema.safeParse({ defaultMode: 42 }).success).toBe(false);
  });

  /**
   * `.passthrough()` covers unknown KEYS only. It does nothing for a known key whose
   * value is outside a closed enum, which is exactly why the enum was load-bearing
   * and why removing it is the fix rather than relaxing the object.
   */
  it('passes through a key this build does not model', () => {
    expect(PermissionsConfigSchema.safeParse({ someFieldAddedLater: 'x' }).success).toBe(true);
  });

  it('accepts the rule arrays it does model', () => {
    const result = PermissionsConfigSchema.safeParse({
      allow: ['Bash(ls *)'],
      deny: ['Read(./.env)'],
      ask: ['Bash(rm *)'],
    });
    expect(result.success).toBe(true);
  });
});
