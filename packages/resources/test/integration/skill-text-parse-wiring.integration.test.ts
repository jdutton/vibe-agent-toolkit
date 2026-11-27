/**
 * The skill-text record's string is the skills lane's string, and the parse
 * cache keeps the record.
 *
 * The SKILL.md lane scans `parseFileCached(...).content`; the bundled-file lane
 * scans the run's `content.read(file, 'markdown').content`. Both are the one
 * `KeyedContent` the run read, so the record the parse job computed is the record
 * either lane would compute, whatever the file's encoding.
 */

import { promises as fs } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { removeScratchDir } from '@vibe-agent-toolkit/utils/testing';
import { decodeTextContent } from '@vibe-agent-toolkit/utils/text';
import { afterEach, beforeEach, describe, expect, inject, it } from 'vitest';

import { computeContentKey, type KeyedContent, type ParserKind } from '../../src/content-key.js';
import { parseHtmlContent } from '../../src/html-link-parser.js';
import { parseMarkdownContent, type ParseResult } from '../../src/link-parser.js';
import { ParseCache } from '../../src/parse-cache.js';
import { ParseDispatcher, parseFileCached } from '../../src/parse-dispatcher.js';
import { NO_GIT_MEMBERS, RunContentCache } from '../../src/projection/content-cache.js';
import { skillTextFactsOf } from '../../src/skill-text/core.js';
import { SKILL_TEXT_DECLARATION } from '../../src/skill-text/declaration.js';
import { ENCODINGS, LF_TEXT } from '../skill-text/encoding-cases.js';
import { PAST_BOUND_MATCHES, PAST_BOUND_TEXT } from '../skill-text/past-bound.js';

/**
 * @param bytes - A file's bytes
 * @param parserKind - The parser they route to
 * @returns The bytes keyed as the run keys them, through the real decoder
 */
function keyedOf(bytes: Uint8Array, parserKind: ParserKind = 'markdown'): KeyedContent {
  const { text, ...decoding } = decodeTextContent(bytes);
  return { content: text, decoding, key: computeContentKey(bytes, parserKind), parserKind, byteLength: bytes.byteLength };
}

let scratch = '';

/** @returns A cache over the scratch directory, a fresh instance each call so a read is a disk read */
function cacheOnDisk(): ParseCache {
  return new ParseCache({ cacheDir: scratch, env: {} });
}

beforeEach(async () => {
  scratch = await fs.mkdtemp(safePath.join(normalizedTmpdir(), 'vat-skill-text-wiring-'));
});

afterEach(async () => {
  await removeScratchDir(scratch);
});

describe('the string the record is computed over is the string the skills lane scans', () => {
  it.each(ENCODINGS)('%s: the parse\'s text is the run\'s read of the file, and the record is the core\'s over it', async (_label, bytes, decoded) => {
    const file = safePath.join(scratch, 'SKILL.md');
    await fs.writeFile(file, bytes);
    const content = new RunContentCache(NO_GIT_MEMBERS);
    const dispatcher = new ParseDispatcher(new ParseCache({ enabled: false }), { content });
    try {
      // The SKILL.md lane's string, then the bundled-file lane's.
      const parsed = await parseFileCached(file, 'markdown', { dispatcher });
      const bundled = (await content.read(file, 'markdown')).content;
      expect(parsed.content).toBe(bundled);
      expect(bundled).toBe(decoded);
      expect(parsed.skillText).toStrictEqual(skillTextFactsOf(bundled, SKILL_TEXT_DECLARATION));
    } finally {
      await dispatcher.shutdown();
    }
  });
});

describe('a record past the bound the caches hold', () => {
  it('refuses nothing on the bounded route, and the cache files no entry for it while it files a held one', async () => {
    const pastFile = safePath.join(scratch, 'past.md');
    const heldFile = safePath.join(scratch, 'held.md');
    await fs.writeFile(pastFile, PAST_BOUND_TEXT);
    await fs.writeFile(heldFile, LF_TEXT);
    // The fixture holds one body line per match past the held bound, so its parse time grows with
    // the machine's load and has run past the default wall-clock cap on a loaded CI runner. Wall
    // clock is not what this proves, and the cache's filing rule never reads the run's limits
    // (`storableUnderDefaultLimits`), so the parse clock is the tier's own per-test allowance:
    // the cap cannot stop the parse before the test's own timeout would.
    const dispatcher = new ParseDispatcher(cacheOnDisk(), { limits: { timeMs: inject('tierTestTimeout') } });
    try {
      const past = await parseFileCached(pastFile, 'markdown', { dispatcher });
      expect(past.skillText?.matches).toHaveLength(PAST_BOUND_MATCHES);
      expect(past.links.map((link) => link.href)).toEqual(['./a.md']);
      expect(past.headings.map((heading) => heading.text)).toEqual(['Big']);
      expect(past.frontmatter).toEqual({ name: 'big' });
      await parseFileCached(heldFile, 'markdown', { dispatcher });
    } finally {
      await dispatcher.shutdown();
    }
    expect(await cacheOnDisk().get(keyedOf(new Uint8Array(Buffer.from(PAST_BOUND_TEXT, 'utf-8'))))).toBeNull();
    expect(await cacheOnDisk().get(keyedOf(new Uint8Array(Buffer.from(LF_TEXT, 'utf-8'))))).not.toBeNull();
  });
});

describe('the parse cache keeps the record', () => {
  it('round-trips a markdown entry\'s record', async () => {
    const keyed = keyedOf(new Uint8Array(Buffer.from(LF_TEXT, 'utf-8')));
    const parsed = parseMarkdownContent(keyed.content, keyed.byteLength);
    expect(await cacheOnDisk().set(keyed, parsed)).toBe(true);
    const hit = await cacheOnDisk().get(keyed);
    expect(hit?.skillText).toStrictEqual(parsed.skillText);
  });

  it('misses a markdown entry that holds no record', async () => {
    const keyed = keyedOf(new Uint8Array(Buffer.from(LF_TEXT, 'utf-8')));
    const parsed: ParseResult = { ...parseMarkdownContent(keyed.content, keyed.byteLength), skillText: null };
    expect(await cacheOnDisk().set(keyed, parsed)).toBe(true);
    expect(await cacheOnDisk().get(keyed)).toBeNull();
  });

  it('misses an HTML entry that holds a record', async () => {
    const source = '<p>as of March 2024</p>\n';
    const keyed = keyedOf(new Uint8Array(Buffer.from(source, 'utf-8')), 'html');
    const parsed: ParseResult = { ...parseHtmlContent(keyed.content, keyed.byteLength), skillText: skillTextFactsOf(source, SKILL_TEXT_DECLARATION) };
    expect(await cacheOnDisk().set(keyed, parsed)).toBe(true);
    expect(await cacheOnDisk().get(keyed)).toBeNull();
  });
});
