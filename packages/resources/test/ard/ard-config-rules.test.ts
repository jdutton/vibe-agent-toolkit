/**
 * The refusals that happen at CONFIG LOAD, before a surface is ever built.
 *
 * Everything here is a value a schema used to accept and an emitter then turned
 * into a conformant-looking entry that addresses nothing or binds nothing. The
 * subject is therefore the *schema's* judgement, not the emitter's — a check
 * that only lives in `buildArdEntry` reports a good message at the wrong moment,
 * after the author has already published the config.
 */

import { describe, expect, it } from 'vitest';

import { ArdEntrySchema } from '../../src/ard/index.js';
import { ArdConfigSchema } from '../../src/schemas/project-config.js';

/** The one publisher every case that is not about the publisher uses. */
const PUBLISHER = 'example.com';

describe('ard.publisher must be a DOMAIN, as its own message insists', () => {
  // 🚨 The message says DOMAIN; the regex `^[a-z0-9.-]+$/i` accepts a single
  // label. `publisher: com` plus `trustManifest.identity:
  // https://totally-unrelated.com/w` was ACCEPTED at exit 0, because the
  // identity's authority `totally-unrelated.com` ends with `.com` — the one
  // security-relevant check in the lane, satisfied by a two-word config.
  it.each(['com', 'localhost', 'example', 'example.', '.com'])(
    'refuses %s, which is not a domain',
    (publisher) => {
      expect(ArdConfigSchema.safeParse({ publisher }).success).toBe(false);
    }
  );

  it.each([PUBLISHER, 'skills.example.co.uk', 'my-org.io'])('accepts %s', (publisher) => {
    expect(ArdConfigSchema.safeParse({ publisher }).success).toBe(true);
  });

  it('names DOMAIN in the refusal, so the fix needs no docs lookup', () => {
    const result = ArdConfigSchema.safeParse({ publisher: 'com' });
    expect(result.success).toBe(false);
    const message = result.success ? '' : result.error.issues.map((i) => i.message).join(' ');
    expect(message).toMatch(/DOMAIN/);
  });
});

describe('ard.baseUrl must be a base entry URLs can RESOLVE against', () => {
  // 🚨 `z.string().url()` admits `mailto:` and any query or fragment. Every one
  // of these produced entries at exit 0 whose `url` addressed nothing and which
  // were mutually indistinguishable — the fragment case resolves to the base
  // itself for every entry in the manifest.
  it.each([
    'https://example.com/base?tenant=acme',
    'https://example.com/base#frag',
    'https://example.com/base?tenant=acme#frag',
    'mailto:ops@example.com',
    'ftp://example.com/base',
  ])('refuses %s', (baseUrl) => {
    expect(ArdConfigSchema.safeParse({ publisher: PUBLISHER, baseUrl }).success).toBe(false);
  });

  it.each([
    'https://example.com/catalog',
    'https://example.com/catalog/',
    'http://localhost:8080/catalog',
  ])('accepts %s', (baseUrl) => {
    expect(ArdConfigSchema.safeParse({ publisher: PUBLISHER, baseUrl }).success).toBe(true);
  });
});

describe('ArdEntrySchema.version', () => {
  // 🚨 `displayName` and `type` both carry `.min(1)`; `version` did not, so a
  // `package.json` carrying `"version": ""` emitted `"version": ""` at exit 0
  // — a field asserting a version that is not one.
  it('refuses an empty string, as its `.min(1)` siblings do', () => {
    const entry = {
      identifier: 'urn:air:example.com:skills:a',
      displayName: 'a',
      type: 'application/ai-skill+md',
      data: {},
      version: '',
    };
    expect(ArdEntrySchema.safeParse(entry).success).toBe(false);
  });

  it('accepts an absent version', () => {
    const entry = {
      identifier: 'urn:air:example.com:skills:a',
      displayName: 'a',
      type: 'application/ai-skill+md',
      data: {},
    };
    expect(ArdEntrySchema.safeParse(entry).success).toBe(true);
  });
});
