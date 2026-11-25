/**
 * The skill-text record rides the markdown parse: the parse job computes it over
 * the very string it parsed. That the string is the one the skills lane scans,
 * read from disk in every encoding, and that the parse cache keeps the record, is
 * `test/integration/skill-text-parse-wiring.integration.test.ts`.
 */

import { decodeTextContent } from '@vibe-agent-toolkit/utils/text';
import { describe, expect, it } from 'vitest';

import { parseHtmlContent } from '../../src/html-link-parser.js';
import { parseMarkdownContent } from '../../src/link-parser.js';
import { skillTextFactsOf } from '../../src/skill-text/core.js';
import { SKILL_TEXT_DECLARATION } from '../../src/skill-text/declaration.js';

import { ENCODINGS, LF_TEXT } from './encoding-cases.js';

describe('the markdown parse carries the skill-text record', () => {
  it('is the core\'s record over the text it parsed', () => {
    const parsed = parseMarkdownContent(LF_TEXT, LF_TEXT.length);
    const expected = skillTextFactsOf(LF_TEXT, SKILL_TEXT_DECLARATION);
    expect(expected.matches.length, 'the document must exercise the match rows').toBeGreaterThan(1);
    expect(parsed.skillText).toStrictEqual(expected);
  });

  it('is null for an HTML parse, which the skills lane never scans', () => {
    expect(parseHtmlContent('<p>as of March 2024</p>\n', 25).skillText).toBeNull();
  });
});

describe('what "the same string" means across encodings', () => {
  it.each(ENCODINGS)('%s: the decoder strips the BOM and keeps every CR', (_label, bytes, decoded) => {
    // Each file's record is over its own decoded text; this pins what that text
    // is, so a CRLF file's record (CRs inside its lines and its H1) is expected,
    // and a BOM moves nothing.
    expect(decodeTextContent(bytes).text).toBe(decoded);
  });
});
