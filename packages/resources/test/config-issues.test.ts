import { describe, it, expect } from 'vitest';
import type { z } from 'zod';

import { formatConfigValidationError } from '../src/config-issues.js';
import { ProjectConfigSchema } from '../src/schemas/project-config.js';

/**
 * Parse something the schema will refuse and hand back the error.
 *
 * @param document - What to try
 * @returns The `ZodError` the schema produced
 */
function refusalOf(document: unknown): z.ZodError {
  const result = ProjectConfigSchema.safeParse(document);
  if (result.success) throw new Error('expected the schema to refuse this document');
  return result.error;
}

describe('formatConfigValidationError', () => {
  it('names the config file, so an adopter with several knows which one', () => {
    const message = formatConfigValidationError(
      refusalOf({ version: 1, resources: { metadata: { frontmatter: true } } }),
      { configPath: '/repo/vibe-agent-toolkit.config.yaml', schema: ProjectConfigSchema },
    );
    expect(message).toContain('/repo/vibe-agent-toolkit.config.yaml');
  });

  it('names the refused key in words, at its dotted path', () => {
    const message = formatConfigValidationError(
      refusalOf({ version: 1, resources: { metadata: { frontmatter: true } } }),
      { configPath: '/repo/config.yaml', schema: ProjectConfigSchema },
    );
    expect(message).toContain('resources: unrecognized key "metadata"');
  });

  it('says the key may have been REMOVED, not only misspelled', () => {
    // The whole reason a strict-schema tightening reads as VAT breaking for no
    // reason: the adopter's config worked yesterday. Saying "removed, and we
    // were discarding it" is the half that makes the refusal make sense.
    const message = formatConfigValidationError(
      refusalOf({ version: 1, resources: { metadata: true } }),
      { schema: ProjectConfigSchema },
    );
    expect(message).toContain('removed from VAT\'s schema');
    expect(message).toContain('silently discarded');
  });

  it('lists the keys that ARE accepted at that path, derived from the schema', () => {
    const message = formatConfigValidationError(
      refusalOf({ version: 1, resources: { cheks: {} } }),
      { schema: ProjectConfigSchema },
    );
    // Derived from `ResourcesConfigSchema.shape` — adding a config key moves
    // this list with no human action, which is why nothing here is hand-listed.
    expect(message).toContain('Accepted here: checks, collections, exclude, include, linkAuth, validation.');
  });

  it('resolves a path THROUGH a record, where the key is data and not schema', () => {
    // `checks` is a ZodRecord, so `orphans` names a check the schema has never
    // heard of. A walker that only knew objects would give up here — and this is
    // the path that matters most, because a misspelled key inside a CHECK is a
    // rule the adopter believes is being enforced.
    const message = formatConfigValidationError(
      refusalOf({
        version: 1,
        resources: { checks: { orphans: { description: 'd', sql: 'SELECT 1', sevrity: 'error' } } },
      }),
      { schema: ProjectConfigSchema },
    );
    expect(message).toContain('resources.checks.orphans: unrecognized key "sevrity"');
    expect(message).toContain('Accepted here: description, severity, sql.');
  });

  it('omits the accepted-key clause rather than guessing when given no schema', () => {
    const message = formatConfigValidationError(
      refusalOf({ version: 1, resources: { metadata: true } }),
    );
    expect(message).toContain('unrecognized key "metadata"');
    expect(message).not.toContain('Accepted here');
  });

  it('renders an ordinary type failure as path plus message', () => {
    const message = formatConfigValidationError(
      refusalOf({ version: 1, resources: { exclude: 'not-an-array' } }),
      { schema: ProjectConfigSchema },
    );
    expect(message).toContain('resources.exclude:');
    expect(message).toContain('array');
  });

  it('emits nothing resembling a JSON dump', () => {
    // The shipped defect: `ZodError.message` is the issue ARRAY, serialized. It
    // named no file, no remedy, and was what five verbs printed before exiting 2.
    const message = formatConfigValidationError(
      refusalOf({ version: 1, resources: { metadata: true } }),
      { configPath: '/repo/config.yaml', schema: ProjectConfigSchema },
    );
    expect(message).not.toContain('"code":');
    expect(message).not.toContain('"path": [');
  });

  it('summarises the tail rather than printing an unbounded wall', () => {
    const checks: Record<string, unknown> = {};
    for (let index = 0; index < 30; index += 1) {
      checks[`c${index}`] = { description: 'd', sql: 'SELECT 1', sevrity: 'error' };
    }
    const message = formatConfigValidationError(
      refusalOf({ version: 1, resources: { checks } }),
      { schema: ProjectConfigSchema },
    );
    expect(message).toContain('… and 10 more issue(s)');
  });

  it('labels a top-level refusal rather than showing an empty path', () => {
    const message = formatConfigValidationError(
      refusalOf({ version: 1, nonsense: true }),
      { schema: ProjectConfigSchema },
    );
    expect(message).toContain('(top level): unrecognized key "nonsense"');
  });
});
