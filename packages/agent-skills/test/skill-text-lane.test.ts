/**
 * The skills lane's two sources for a document's skill-text record: the run's
 * store, and the file's text (counted once per file per run). The golden
 * (`test/fixtures/skill-text-golden`) pins what the constructors build from a
 * record; this pins which source answers, and what each one counts.
 */

import { writeFileSync } from 'node:fs';

import {
  type ParseDispatcher,
  SKILL_TEXT_DECLARATION,
  skillTextFactsOf,
  type StoredDocumentFacts,
} from '@vibe-agent-toolkit/resources';
import { readWorkCounters, safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import {
  linkedFileSkillText,
  readSkillDocument,
  scannedSkillText,
  skillNameOf,
  type SkillDocument,
  type SkillDocumentDecoding,
  storedSkillText,
  type SkillTextRun,
} from '../src/skill-text-lane.js';

import { setupParseRoute, setupTempDir } from './test-helpers.js';

const ROUTE = setupParseRoute();
const { getTempDir } = setupTempDir('skill-text-lane-');

const SKILL_TEXT = '---\nname: from-frontmatter\n---\n# Heading\n\nYou should run it.\n';

/** `skillText.storeMiss` now. */
const misses = (): number => readWorkCounters()['skillText.storeMiss'];

/** `skillText.noStore` now. */
const noStores = (): number => readWorkCounters()['skillText.noStore'];

/** `content.read` now. */
const reads = (): number => readWorkCounters()['content.read'];

/** How a BOM-less UTF-8 file decodes. */
const PLAIN_UTF8: SkillDocumentDecoding = { encoding: 'utf-8', encodingSource: 'assumed' };

/** A dispatcher no parse may reach: a served read must not parse. */
const NO_PARSE = {} as ParseDispatcher;

/** A store holding `text`'s facts for every file it is asked about. */
function storeOf(text: string): SkillTextRun['source'] & { storedDocument: ReturnType<typeof vi.fn> } {
  const facts = { frontmatter: { name: 'stored' }, frontmatterError: undefined, links: [], skillText: skillTextFactsOf(text, SKILL_TEXT_DECLARATION) };
  return { storedDocument: vi.fn(() => Promise.resolve({ facts, decoding: PLAIN_UTF8 } as unknown as StoredDocumentFacts)), holdsStore: true };
}

/** A store that holds nothing. */
const EMPTY_STORE: SkillTextRun['source'] = { storedDocument: () => Promise.resolve(undefined), holdsStore: true };

/** A run's source with no store to ask. */
const NO_STORE: SkillTextRun['source'] = { storedDocument: () => Promise.resolve(undefined), holdsStore: false };

/** A run over `source` whose dispatcher no parse reaches: it identifies the run. */
function scanRun(source: SkillTextRun['source']): SkillTextRun {
  return { source, dispatcher: {} as ParseDispatcher, crawlOnce: (_key, crawl) => crawl() };
}

/** A SKILL.md holding {@link SKILL_TEXT} in a fresh directory. */
function skillFile(): string {
  const path = safePath.join(getTempDir(), 'SKILL.md');
  writeFileSync(path, SKILL_TEXT);
  return path;
}

/** A document with `frontmatter` and the H1 `h1`. */
function documentWith(frontmatter: Record<string, unknown> | undefined, h1: string | null): SkillDocument {
  return {
    frontmatter,
    frontmatterError: undefined,
    frontmatterNotAMapping: false,
    links: [],
    skillText: { lineCount: 1, h1, frontmatterFence: 'closed', matches: [] },
    decoding: PLAIN_UTF8,
    text: () => Promise.reject(new Error('no detector reads this document\'s text')),
  };
}

describe('skillNameOf', () => {
  it('takes a non-empty string frontmatter name', () => {
    expect(skillNameOf(documentWith({ name: 'declared' }, ' Heading'), '/x/SKILL.md')).toBe('declared');
  });

  it('falls to the H1, trimmed, when the name is empty or not a string', () => {
    expect(skillNameOf(documentWith({ name: '' }, '  Heading \r'), '/x/SKILL.md')).toBe('Heading');
    expect(skillNameOf(documentWith({ name: 7 }, 'Heading'), '/x/SKILL.md')).toBe('Heading');
  });

  it('keeps a whitespace-only H1 as the empty name, as the raw capture is truthy', () => {
    expect(skillNameOf(documentWith(undefined, '   '), '/x/SKILL.md')).toBe('');
  });

  it('falls to the file basename with no H1', () => {
    expect(skillNameOf(documentWith(undefined, null), '/x/notes.md')).toBe('notes');
    expect(skillNameOf(documentWith(undefined, ''), '/x/notes.md')).toBe('notes');
  });
});

describe('readSkillDocument', () => {
  it('answers from the store without a parse or a count', async () => {
    const source = storeOf(SKILL_TEXT);
    const before = misses();
    const document = await readSkillDocument('/nowhere/SKILL.md', { source, dispatcher: NO_PARSE }, 'source');
    expect(document.frontmatter).toEqual({ name: 'stored' });
    expect(document.skillText.h1).toBe('Heading');
    expect(document.decoding).toEqual(PLAIN_UTF8);
    expect(source.storedDocument).toHaveBeenCalledWith('/nowhere/SKILL.md', 'markdown');
    expect(misses() - before).toBe(0);
  });

  it('parses a file the store does not serve, counting it once per run', async () => {
    const path = skillFile();
    const run: SkillTextRun = { source: EMPTY_STORE, dispatcher: ROUTE.dispatcher as ParseDispatcher, crawlOnce: (_key, crawl) => crawl() };
    const before = misses();
    const first = await readSkillDocument(path, run, 'source');
    await readSkillDocument(path, run, 'source');
    expect(first.frontmatter).toEqual({ name: 'from-frontmatter' });
    expect(first.skillText).toEqual(skillTextFactsOf(SKILL_TEXT, SKILL_TEXT_DECLARATION));
    expect(first.decoding).toEqual(PLAIN_UTF8);
    expect(misses() - before).toBe(1);
  });

  it('carries the decoding of a BOM-marked file it parses', async () => {
    const path = safePath.join(getTempDir(), 'SKILL.md');
    writeFileSync(path, `\uFEFF${SKILL_TEXT}`);
    const document = await readSkillDocument(path, undefined, 'source');
    expect(document.decoding).toEqual({ encoding: 'utf-8', encodingSource: 'bom' });
    expect(document.frontmatter).toEqual({ name: 'from-frontmatter' });
  });

  it('counts a file a run with no store parses as noStore once per run, never as a miss', async () => {
    const path = skillFile();
    const run: SkillTextRun = { source: NO_STORE, dispatcher: ROUTE.dispatcher as ParseDispatcher, crawlOnce: (_key, crawl) => crawl() };
    const [missesBefore, noStoresBefore] = [misses(), noStores()];
    await readSkillDocument(path, run, 'source');
    await readSkillDocument(path, run, 'source');
    expect([misses() - missesBefore, noStores() - noStoresBefore]).toEqual([0, 1]);
  });

  it('counts every read of a caller with no run as noStore, never as a miss', async () => {
    const path = skillFile();
    const [missesBefore, noStoresBefore] = [misses(), noStores()];
    await readSkillDocument(path, undefined, 'source');
    await readSkillDocument(path, undefined, 'source');
    expect([misses() - missesBefore, noStores() - noStoresBefore]).toEqual([0, 2]);
  });
});

describe('storedSkillText', () => {
  it('answers from the store without a count', async () => {
    const source = storeOf(SKILL_TEXT);
    const before = misses();
    const facts = await storedSkillText('/nowhere/ref.md', { source, dispatcher: NO_PARSE });
    expect(facts?.h1).toBe('Heading');
    expect(source.storedDocument).toHaveBeenCalledWith('/nowhere/ref.md', 'markdown');
    expect(misses() - before).toBe(0);
  });

  it('answers undefined for a file the store does not serve, counting nothing', async () => {
    const before = misses();
    expect(await storedSkillText('/nowhere/ref.md', { source: EMPTY_STORE, dispatcher: NO_PARSE })).toBeUndefined();
    expect(misses() - before).toBe(0);
  });
});

describe('scannedSkillText', () => {
  it('runs the core over the text, counting the file once per run as a miss in a run with a store', () => {
    const text = '# Ref\n\nYou must call it.\n';
    const run = scanRun(EMPTY_STORE);
    const [missesBefore, noStoresBefore] = [misses(), noStores()];
    const facts = scannedSkillText('/nowhere/ref.md', text, run);
    scannedSkillText('/nowhere/ref.md', text, run);
    expect(facts).toEqual(skillTextFactsOf(text, SKILL_TEXT_DECLARATION));
    expect([misses() - missesBefore, noStores() - noStoresBefore]).toEqual([1, 0]);
  });

  it('counts the file once per run as noStore, never as a miss, in a run with no store', () => {
    const text = '# Ref\n\nYou must call it.\n';
    const run = scanRun(NO_STORE);
    const [missesBefore, noStoresBefore] = [misses(), noStores()];
    scannedSkillText('/nowhere/ref.md', text, run);
    scannedSkillText('/nowhere/ref.md', text, run);
    expect([misses() - missesBefore, noStores() - noStoresBefore]).toEqual([0, 1]);
  });

  it('answers the same text a run already scanned from that scan, and rescans changed text', () => {
    const run = scanRun(EMPTY_STORE);
    const first = scannedSkillText('/nowhere/ref.md', '# One\n', run);
    expect(scannedSkillText('/nowhere/ref.md', '# One\n', run)).toBe(first);
    const changed = scannedSkillText('/nowhere/ref.md', '# Two\n', run);
    expect(changed).not.toBe(first);
    expect(changed.h1).toBe('Two');
  });
});

describe('linkedFileSkillText', () => {
  it('serves a plain UTF-8 file from its document, reading and counting nothing', () => {
    const document = documentWith(undefined, 'Heading');
    const [missesBefore, readsBefore] = [misses(), reads()];
    expect(linkedFileSkillText('/nowhere/ref.md', document, scanRun(EMPTY_STORE))).toBe(document.skillText);
    expect([misses() - missesBefore, reads() - readsBefore]).toEqual([0, 0]);
  });

  it('scans the raw UTF-8 text of a BOM-marked file, BOM kept, counted as a read and a miss', () => {
    const path = safePath.join(getTempDir(), 'ref.md');
    const raw = '\uFEFF```bash\naz login\n```\n';
    writeFileSync(path, raw);
    const document = { ...documentWith(undefined, null), decoding: { encoding: 'utf-8', encodingSource: 'bom' } } as const;
    const [missesBefore, readsBefore] = [misses(), reads()];
    const facts = linkedFileSkillText(path, document, scanRun(EMPTY_STORE));
    expect(facts).toEqual(skillTextFactsOf(raw, SKILL_TEXT_DECLARATION));
    expect(facts).not.toEqual(skillTextFactsOf(raw.slice(1), SKILL_TEXT_DECLARATION));
    expect([misses() - missesBefore, reads() - readsBefore]).toEqual([1, 1]);
  });
});
