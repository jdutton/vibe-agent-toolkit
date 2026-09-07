/**
 * Unknown config keys warn; everything else still refuses.
 *
 * 🚨 The distinction this file exists to hold. A key VAT has no field for is a
 * key VAT was ALREADY discarding — before the schema went strict it was silently
 * stripped, so going strict converted years of silent acceptance into a hard
 * exit for a field that never did anything. A real adopter's
 * `resources.metadata` blocked `vat claude org skills install`, a command that
 * loads config only to decide which eval suites to withhold and never reads that
 * section, in every worktree at once.
 *
 * ⚠️ The downgrade is ONLY for unrecognized keys. A missing required field or a
 * wrong type means VAT would act on a config it misread, and those still throw.
 * "I do not know this word" is not "I misunderstood your instruction", and the
 * strict-everything behaviour collapsed exactly that difference.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { parseConfigAllowingUnknownKeys } from '../src/config-issues.js';

/** A nested strict schema, the shape the real project config has. */
const Schema = z.object({
  version: z.number(),
  resources: z.object({ include: z.array(z.string()).optional() }).strict().optional(),
}).strict();

/** Collect warnings so a test can assert one was raised — or that none was. */
function sink(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

describe('parseConfigAllowingUnknownKeys', () => {
  it('parses a clean config without warning', () => {
    const s = sink();

    const config = parseConfigAllowingUnknownKeys(Schema, { version: 1 }, s.warn);

    expect(config.version).toBe(1);
    expect(s.messages).toEqual([]);
  });

  it('drops an unknown NESTED key and warns instead of throwing', () => {
    const s = sink();

    // The adopter's exact shape: a retired key under a real section.
    const config = parseConfigAllowingUnknownKeys(
      Schema,
      { version: 1, resources: { include: ['a.md'], metadata: { frontmatter: true } } },
      s.warn,
    );

    expect(config.resources).toEqual({ include: ['a.md'] });
    expect(s.messages).toHaveLength(1);
    // The warning must still carry the diagnosis, not just the fact of dropping:
    // naming the key is what lets an adopter delete it.
    expect(s.messages[0]).toContain('metadata');
    expect(s.messages[0]).toContain('Ignoring the unknown key(s) and continuing');
  });

  it('still THROWS on a wrong type, and warns about nothing', () => {
    const s = sink();

    expect(() => parseConfigAllowingUnknownKeys(Schema, { version: 'one' }, s.warn))
      .toThrow(/Expected number/);
    expect(s.messages).toEqual([]);
  });

  it('still THROWS on a missing required field', () => {
    const s = sink();

    expect(() => parseConfigAllowingUnknownKeys(Schema, {}, s.warn)).toThrow(/version/);
    expect(s.messages).toEqual([]);
  });

  it('throws when a config has BOTH an unknown key and a real error', () => {
    const s = sink();

    // The unknown key must not buy forgiveness for the type error beside it.
    expect(() => parseConfigAllowingUnknownKeys(Schema, { version: 'one', nope: 1 }, s.warn)).toThrow();
    expect(s.messages).toEqual([]);
  });

  it('does not mutate the caller\'s document', () => {
    const s = sink();
    const raw = { version: 1, resources: { metadata: true } };

    parseConfigAllowingUnknownKeys(Schema, raw, s.warn);

    // The stripped copy is VAT's business; the caller's object is not.
    expect(raw.resources).toEqual({ metadata: true });
  });
});
