import { describe, expect, it } from 'vitest';

import {
  externalDestination,
  outOfCorpusDestination,
  resourceDestination,
} from '../src/projection/edge-destination.js';
import { EdgeResolutionRowSchema } from '../src/schemas/projection-edges.js';

/** An opaque resource id, as `identity.ts` mints them. */
const GUIDE_ID = 'res-0123456789abcdef0123456789abcdef';

/** The path two normalization assertions must agree on. */
const GUIDE_PATH = 'docs/guide.md';

/** The origin the scheme/host/port assertions vary around. */
const EXAMPLE_DOC = 'https://example.com/x';

/**
 * The columns a builder does NOT decide, so a built destination can be checked
 * against the shipped row schema rather than against a restatement of it.
 */
const EDGE_COLUMNS = {
  src: 'res-fedcba9876543210fedcba9876543210',
  refOrdinal: 0,
  contextId: 'wiki:primary',
  candidateOrdinal: 0,
  tier: null,
  score: null,
};

describe('resourceDestination', () => {
  it('keys an in-corpus target on its own resource id', () => {
    expect(resourceDestination(GUIDE_ID, null)).toEqual({
      dstKind: 'resource',
      dstKey: GUIDE_ID,
      dstResource: GUIDE_ID,
      dstAnchor: null,
    });
  });

  it('carries an anchor through', () => {
    expect(resourceDestination(GUIDE_ID, 'installation').dstAnchor).toBe('installation');
  });
});

describe('outOfCorpusDestination', () => {
  it('is not a resource, so it names no foreign key', () => {
    expect(outOfCorpusDestination('../memory/MEMORY.md', null)).toEqual({
      dstKind: 'out-of-corpus',
      dstKey: '../memory/MEMORY.md',
      dstResource: null,
      dstAnchor: null,
    });
  });

  it('collapses . and .. lexically so two spellings of one path share a key', () => {
    const viaDot = outOfCorpusDestination('docs/./guides/../guide.md', null);
    expect(viaDot.dstKey).toBe(outOfCorpusDestination(GUIDE_PATH, null).dstKey);
  });

  it('forward-slashes a backslash-spelled path', () => {
    expect(outOfCorpusDestination(String.raw`docs\guide.md`, null).dstKey).toBe(GUIDE_PATH);
  });

  it('does NOT case-fold — a case-only rename is a different target', () => {
    expect(outOfCorpusDestination('docs/Guide.md', null).dstKey)
      .not.toBe(outOfCorpusDestination(GUIDE_PATH, null).dstKey);
  });
});

describe('externalDestination', () => {
  it('lowercases the scheme and the host, which RFC 3986 §3.2.2 makes case-insensitive', () => {
    expect(externalDestination('HTTPS://Example.COM/x').dstKey).toBe(EXAMPLE_DOC);
  });

  it('does NOT lowercase the path — path case is significant on a case-sensitive server', () => {
    expect(externalDestination('https://example.com/Path/To/Doc').dstKey)
      .toBe('https://example.com/Path/To/Doc');
  });

  it('drops the scheme default port, so two spellings of one origin share a key', () => {
    expect(externalDestination('https://example.com:443/x').dstKey).toBe(EXAMPLE_DOC);
    expect(externalDestination('http://example.com:80/x').dstKey)
      .toBe(externalDestination('http://example.com/x').dstKey);
  });

  it('keeps a non-default port, which names a different origin', () => {
    expect(externalDestination('https://example.com:8443/x').dstKey).toContain(':8443');
  });

  it('keeps the query string, which commonly identifies a distinct resource', () => {
    const key = externalDestination('https://example.com/m?project=a&metric=b').dstKey;
    expect(key).toContain('project=a');
    expect(key).toContain('metric=b');
  });

  it('removes the fragment from the key and carries it on dstAnchor', () => {
    const withFragment = externalDestination(`${EXAMPLE_DOC}#install`);
    expect(withFragment.dstAnchor).toBe('install');
    expect(withFragment.dstKey).toBe(EXAMPLE_DOC);
  });

  it('groups two links to different sections of one page onto one key', () => {
    const a = externalDestination(`${EXAMPLE_DOC}#a`);
    const b = externalDestination(`${EXAMPLE_DOC}#b`);
    expect(a.dstKey).toBe(b.dstKey);
    expect(a.dstAnchor).not.toBe(b.dstAnchor);
  });

  it('never names a dstResource — an external target must never be a resource', () => {
    expect(externalDestination(EXAMPLE_DOC).dstResource).toBeNull();
    expect(externalDestination(EXAMPLE_DOC).dstKind).toBe('external');
  });

  it('handles a non-http scheme', () => {
    // ⚠️ Asserting only `dstKind === 'external'` was vacuous: that field is a
    // hardcoded literal in the builder, so the assertion held for EVERY input,
    // including ones that throw today. Assert the KEY, which is what the
    // normalization actually decides.
    expect(externalDestination('mailto:Someone@Example.com').dstKey)
      .toBe('mailto:Someone@Example.com');
  });

  it('falls back to the raw token, minus any fragment, when the URI will not parse', () => {
    // Protocol-relative: `isNonLocalRef` treats it as external, and `new URL`
    // cannot parse it without a base. Keyed as far as it can honestly be.
    const relative = externalDestination('//cdn.example.com/lib.js#top');
    expect(relative.dstKind).toBe('external');
    expect(relative.dstKey).toBe('//cdn.example.com/lib.js');
    expect(relative.dstAnchor).toBe('top');
  });

  it('REFUSES a reference that names nothing, rather than keying it on emptiness', () => {
    // 🪤 The previous version of this test asserted `dstKey.length > 0` for
    // '//#frag' — and was VACUOUS: that input yields '//' even with the fallback
    // deleted, because `normalizeUri` returns it unchanged and '//' is truthy.
    // The inputs that actually reach the fallback are '#f', '#' and '' — none
    // was tested, and '' produced the empty key the schema rejects, which is
    // the hole in this module's "unconstructible" claim. ('#f' keys on '#f' and
    // '#' on '#'; only the empty token has nothing to key.)
    expect(() => externalDestination('')).toThrow(/names something/u);
    expect(() => resourceDestination('', null)).toThrow(/non-empty/u);
    // A bare '#' is NOT refused: its key is '#', which is non-empty and is the
    // same treatment '#frag' gets. Only a token with nothing at all in it has no
    // destination to key.
    expect(externalDestination('#').dstKey).toBe('#');
  });

  it('still keys a fragment-only reference on its raw token', () => {
    // The case the fallback was written for, and which must keep working: the
    // fragment-free half is empty but the token itself is not.
    expect(externalDestination('#frag').dstKey).toBe('#frag');
  });

  it('refuses an empty anchor, because that is the ABSENCE of one', () => {
    expect(() => resourceDestination('res-1', '')).toThrow(/empty anchor/u);
    expect(() => outOfCorpusDestination('a.md', '')).toThrow(/empty anchor/u);
  });

  it('keys a path whose FILENAME contains a hash, rather than refusing it', () => {
    // 🚨 The regression test for a crash a guard introduced. A `#` here is a
    // legal POSIX filename character, not an unsplit fragment: `splitHrefAnchor`
    // cuts the raw href at its first `#` BEFORE `resolveLocalHref`
    // percent-decodes what remains, so `[t](./release%23notes.md)` — the RFC
    // 3986 spelling of a file named `release#notes.md` — reaches this builder
    // with a `#` that was never a delimiter.
    //
    // A guard that refused it made `vat resources query` exit 2 on a two-file
    // corpus whose only link was that one, once per extent.
    expect(outOfCorpusDestination('release#notes.md', null).dstKey)
      .toBe('release#notes.md');
    // And the anchor still arrives separately, so nothing is folded into the
    // key — which is what the refusal was trying to protect.
    const withAnchor = outOfCorpusDestination('docs/a#b.md', 'sec');
    expect(withAnchor.dstKey).toBe('docs/a#b.md');
    expect(withAnchor.dstAnchor).toBe('sec');
  });
});

describe('every builder satisfies the shipped row schema by construction', () => {
  const built = [
    resourceDestination(GUIDE_ID, 'anchor'),
    outOfCorpusDestination('../outside.md', null),
    externalDestination(`${EXAMPLE_DOC}#f`),
    externalDestination('//cdn.example.com/lib.js'),
  ];

  it.each(built.map((destination) => [destination.dstKind, destination] as const))(
    'a %s destination parses',
    (_kind, destination) => {
      const result = EdgeResolutionRowSchema.safeParse({ ...EDGE_COLUMNS, ...destination });
      expect(result.success).toBe(true);
    },
  );

  it('covers all three destination classes, so no class is silently untested', () => {
    expect(new Set(built.map((destination) => destination.dstKind)).size).toBe(3);
  });
});
