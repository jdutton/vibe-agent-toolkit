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

/**
 * A nested strict schema, the shape the real project config has.
 *
 * `blocks` is a RECORD of strict objects so a fixture can produce an arbitrary
 * number of independent `unrecognized_keys` issues — Zod reports one per object,
 * not one per key — and `test` sits after it in shape order so a type error there
 * lands past the render cap. That ordering is the whole point of the truncation
 * test below; do not reorder the shape.
 */
const Schema = z.object({
  version: z.number(),
  resources: z.object({ include: z.array(z.string()).optional() }).strict().optional(),
  blocks: z.record(z.object({ note: z.string().optional() }).strict()).optional(),
  test: z.object({ concurrency: z.number() }).strict().optional(),
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
    //
    // ⚠️ The MATCHER is the test. This assertion used to be a bare `.toThrow()`
    // with nothing to match, which is satisfied by any message at all — so it was
    // green while the shipped message named only the unknown key and never
    // mentioned the type error that caused the refusal. An unmatched `.toThrow()`
    // pins that a throw happened, not that the throw said anything true.
    expect(() => parseConfigAllowingUnknownKeys(Schema, { version: 'one', nope: 1 }, s.warn))
      .toThrow(/Expected number/);
    expect(s.messages).toEqual([]);
  });

  it('renders the FATAL issue even when 25 unknown keys are reported before it', () => {
    // 🚨 The truncation hole. `formatConfigValidationError` slices to the first
    // 20 issues while `onlyUnknownKeys` is computed over ALL of them, so a config
    // whose one fatal issue sorts past position 20 was refused with a message
    // containing nothing but unrecognized-key blocks — each ending "Delete it, or
    // correct the spelling." — plus "… and N more issue(s)". The adopter is told
    // the config is refused, shown only complaints about keys that are explicitly
    // NO LONGER FATAL, and handed a remedy that cannot lift the refusal.
    const s = sink();
    const manyUnknownKeys = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`block${String(i)}`, { note: 'x', stale: true }]),
    );

    let message = '';
    try {
      parseConfigAllowingUnknownKeys(
        Schema,
        { version: 1, blocks: manyUnknownKeys, test: { concurrency: 'four' } },
        s.warn,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    // The issue that DECIDED the outcome has to survive the cap.
    expect(message).toContain('test.concurrency');
    expect(message).toContain('Expected number');
    // The cap itself is untouched — this is a reordering, not a raised limit.
    expect(message).toContain('more issue(s)');
    expect(s.messages).toEqual([]);
  });

  it('says so when dropping the refused keys does NOT make the config valid', () => {
    // The belt-and-braces arm, reached through a STUB rather than a real schema,
    // and the stub is the finding as much as the assertion is: no Zod schema can
    // reach this branch. `.refine()` was the obvious candidate and Zod runs the
    // effect even when the inner object refuses a key, so the first parse already
    // carries a non-unknown-key issue and the function throws one branch earlier.
    // The arm is therefore unreachable today — but its message was still wrong: a
    // pure unknown-keys diagnosis whose every remedy reads "delete it", handed to
    // an adopter after deleting has just been tried and failed. A stub is the only
    // honest way to hold that message; writing a "realistic" fixture that quietly
    // exercised a different branch would be worse than none.
    const s = sink();
    const alwaysRefusesTheSameKey = {
      safeParse: () => ({
        success: false as const,
        error: new z.ZodError([
          {
            code: z.ZodIssueCode.unrecognized_keys,
            keys: ['extra'],
            path: [],
            message: "Unrecognized key(s) in object: 'extra'",
          },
        ]),
      }),
    } as unknown as z.ZodTypeAny;

    let message = '';
    try {
      parseConfigAllowingUnknownKeys(alwaysRefusesTheSameKey, { version: 1, extra: true }, s.warn);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('unrecognized key "extra"');
    expect(message).toContain('the diagnosis above is incomplete');
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
