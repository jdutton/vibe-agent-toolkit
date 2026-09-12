/**
 * The re-base that lets `transformContent` splice a frontmatter-stripped body.
 *
 * `resource.links` are parsed from the WHOLE file; the rewrite runs over the body
 * with the frontmatter removed. One subtraction moves every span — but only if
 * the body really is a suffix of the content it is subtracted from, and that used
 * to be an assumption with a docstring rather than a check.
 *
 * ## Why this is not covered by "splicableFrom refuses a bad span"
 *
 * It was claimed to be. `splicableFrom` compares the span's destination to the
 * parser's href and refuses a mismatch, and the packager's docstring called that
 * its backstop — "a misalignment that survives this degrades to no rewrite rather
 * than to a wrong one". That is FALSE and the counterexample is pinned in
 * `packages/resources/test/content-transform.test.ts` › "two links sharing an
 * href defeat the destination comparison": the comparison is keyed on a value two
 * links can have in common, so a stale span landing on a same-href neighbour
 * passes it and the rewrite goes to the wrong construct. A mitigation keyed on a
 * shared value cannot be a guarantee. The guarantee has to be the precondition,
 * verified here.
 */

import type { ResourceLink } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { bodyRelativeLinks } from '../src/skill-packager.js';

const LF = String.fromCodePoint(0x0a);
const HREF = './guide.md';
const FRONTMATTER = `---${LF}title: T${LF}---${LF}${LF}`;
const BODY = `Intro.${LF}${LF}See [Guide](${HREF}).${LF}`;
const CONTENT = `${FRONTMATTER}${BODY}`;

/** The whole-file span of the one link in {@link BODY}. */
const WHOLE_FILE_START = CONTENT.indexOf('[Guide]');
const WHOLE_FILE_END = CONTENT.indexOf(')', WHOLE_FILE_START) + 1;

/**
 * A link carrying whole-file offsets, as the parser reports them.
 *
 * @param overrides - Fields to replace
 * @returns The link
 */
function wholeFileLink(overrides: Partial<ResourceLink> = {}): ResourceLink {
  return {
    text: 'Guide',
    href: HREF,
    type: 'local_file',
    nodeType: 'link',
    startOffset: WHOLE_FILE_START,
    endOffset: WHOLE_FILE_END,
    ...overrides,
  };
}

/** Collects what the re-base reported as unverifiable. */
function recorder(): { calls: number; warn: () => void } {
  const state = { calls: 0, warn: () => { state.calls += 1; } };
  return state;
}

describe('bodyRelativeLinks — a body that IS a suffix of the content', () => {
  it('moves the span onto the same characters', () => {
    // The mechanism, not the arithmetic. Asserting `start - 20` would pass for a
    // wrong constant too; asserting that the re-based span still slices out the
    // link cannot.
    const log = recorder();

    const [rebased] = bodyRelativeLinks(CONTENT, BODY, [wholeFileLink()], log.warn);

    expect(BODY.slice(rebased?.startOffset ?? 0, rebased?.endOffset ?? 0)).toBe(`[Guide](${HREF})`);
    expect(CONTENT.slice(WHOLE_FILE_START, WHOLE_FILE_END)).toBe(`[Guide](${HREF})`);
    expect(log.calls).toBe(0);
  });

  it('leaves a link with no span alone, and keeps its other fields', () => {
    const log = recorder();
    const spanless = { text: 'Guide', href: HREF, type: 'local_file' as const, line: 3 };

    expect(bodyRelativeLinks(CONTENT, BODY, [spanless], log.warn)).toEqual([spanless]);
    expect(log.calls).toBe(0);
  });

  it('is a no-op when there is no frontmatter to strip', () => {
    const log = recorder();
    const links = [wholeFileLink({ startOffset: 4, endOffset: 20 })];

    expect(bodyRelativeLinks(BODY, BODY, links, log.warn)).toEqual(links);
    expect(log.calls).toBe(0);
  });
});

describe('bodyRelativeLinks — a body that is NOT a suffix of the content', () => {
  // The condition the subtraction requires, stated exactly: `content.endsWith(body)`
  // is true if and only if every body index maps to `index + (content.length -
  // body.length)` in content. When it is false the difference of two lengths is
  // an arbitrary number, and applying it produces coordinates nothing verified.
  const NOT_A_SUFFIX = `${BODY}trailing${LF}`;
  // Same LENGTH as the body, different bytes — the shape that makes an
  // offset-zero re-base silently wrong, and the one a length check alone misses.
  const SAME_LENGTH = BODY.replace('Intro.', 'Other.');

  it.each([
    ['a body longer than the content', BODY, NOT_A_SUFFIX],
    ['a body that is a PREFIX, not a suffix', `${BODY}tail`, BODY],
    ['a body of equal length but different bytes', CONTENT, `${FRONTMATTER}${SAME_LENGTH}`.slice(0, CONTENT.length)],
  ])('reports %s instead of re-basing it', (_name, content, body) => {
    const log = recorder();

    bodyRelativeLinks(content, body, [wholeFileLink()], log.warn);

    expect(log.calls).toBe(1);
  });

  it('returns the links with NO span, so nothing splices at unverified coordinates', () => {
    // 🚨 Not "returns them unchanged". An unchanged link keeps a whole-file span
    // that addresses the body's bytes by accident, which is precisely the
    // mis-splice this guard exists to prevent. Dropping the span makes the link
    // UNRECOGNISED to `splicableFrom`, which sends it to the pre-span regex
    // replay — the behaviour this call site had before spans existed, and a
    // documented degrade rather than a silent one.
    const log = recorder();

    const [rebased] = bodyRelativeLinks(CONTENT, NOT_A_SUFFIX, [wholeFileLink()], log.warn);

    expect(rebased?.startOffset).toBeUndefined();
    expect(rebased?.endOffset).toBeUndefined();
    expect('startOffset' in (rebased ?? {})).toBe(false);
    expect('endOffset' in (rebased ?? {})).toBe(false);
    // Everything that is not a coordinate survives — the link is still a link.
    expect(rebased?.href).toBe(HREF);
    expect(rebased?.text).toBe('Guide');
    expect(rebased?.nodeType).toBe('link');
    expect(log.calls).toBe(1);
  });
});
