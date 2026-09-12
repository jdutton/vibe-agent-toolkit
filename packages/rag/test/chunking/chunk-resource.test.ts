/**
 * Tests for resource chunking
 */

import type { HeadingNode } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import type { ChunkableResource } from '../../src/chunking/chunk-resource.js';
import { chunkResource, enrichChunks } from '../../src/chunking/chunk-resource.js';
import { ApproximateTokenCounter } from '../../src/token-counters/approximate-token-counter.js';

describe('chunkResource', () => {
  const tokenCounter = new ApproximateTokenCounter();
  const TEST_RESOURCE_ID = 'test-resource';

  it('should chunk simple markdown resource', () => {
    const resource: ChunkableResource = {
      id: TEST_RESOURCE_ID,
      filePath: '/test.md',
      content: '# Heading 1\n\nContent under heading 1.\n\n## Heading 2\n\nContent under heading 2.',
      contentHash: 'abc123',
      estimatedTokenCount: 20,
      links: [],
      headings: [
        {
          level: 1,
          text: 'Heading 1',
          slug: 'heading-1',
          line: 1,
        },
        {
          level: 2,
          text: 'Heading 2',
          slug: 'heading-2',
          line: 5,
        },
      ],
      frontmatter: {},
    };

    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const result = chunkResource(resource, config);

    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.stats.totalChunks).toBe(result.chunks.length);

    // Check chunk structure
    for (const chunk of result.chunks) {
      expect(chunk.content).toBeTruthy();
      expect(typeof chunk.content).toBe('string');
    }
  });

  it('should preserve heading paths', () => {
    const resource: ChunkableResource = {
      id: TEST_RESOURCE_ID,
      filePath: '/test.md',
      content: '# Main\n\nContent.\n\n## Sub\n\nMore content.',
      contentHash: 'abc123',
      estimatedTokenCount: 15,
      links: [],
      headings: [
        {
          level: 1,
          text: 'Main',
          slug: 'main',
          line: 1,
        },
        {
          level: 2,
          text: 'Sub',
          slug: 'sub',
          line: 5,
        },
      ],
      frontmatter: {},
    };

    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const result = chunkResource(resource, config);

    // Should have chunks with heading paths
    const chunksWithHeadings = result.chunks.filter((c) => c.headingPath);
    expect(chunksWithHeadings.length).toBeGreaterThan(0);
  });

  it('should create multiple chunks from multiple headings', () => {
    const resource: ChunkableResource = {
      id: TEST_RESOURCE_ID,
      filePath: '/test.md',
      content: '# H1\n\nContent 1.\n\n# H2\n\nContent 2.\n\n# H3\n\nContent 3.',
      contentHash: 'abc123',
      estimatedTokenCount: 20,
      links: [],
      headings: [
        { level: 1, text: 'H1', slug: 'h1', line: 1 },
        { level: 1, text: 'H2', slug: 'h2', line: 5 },
        { level: 1, text: 'H3', slug: 'h3', line: 9 },
      ],
      frontmatter: {},
    };

    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const result = chunkResource(resource, config);

    // Should create multiple chunks (one per heading section)
    expect(result.chunks.length).toBeGreaterThanOrEqual(3);

    // Each chunk should have content
    for (const chunk of result.chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('should handle resource with no headings', () => {
    const resource: ChunkableResource = {
      id: TEST_RESOURCE_ID,
      filePath: '/test.md',
      content: 'Plain text without headings.',
      contentHash: 'abc123',
      estimatedTokenCount: 10,
      links: [],
      headings: [],
      frontmatter: {},
    };

    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const result = chunkResource(resource, config);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toBe('Plain text without headings.');
  });

  it('should calculate accurate statistics', () => {
    const resource: ChunkableResource = {
      id: TEST_RESOURCE_ID,
      filePath: '/test.md',
      content: '# H1\n\nShort content.',
      contentHash: 'abc123',
      estimatedTokenCount: 10,
      links: [],
      headings: [{ level: 1, text: 'H1', slug: 'h1', line: 1 }],
      frontmatter: {},
    };

    const config = {
      targetChunkSize: 512,
      modelTokenLimit: 8191,
      paddingFactor: 0.9,
      tokenCounter,
    };

    const result = chunkResource(resource, config);

    expect(result.stats.totalChunks).toBe(result.chunks.length);
    expect(result.stats.averageTokens).toBeGreaterThan(0);
    expect(result.stats.maxTokens).toBeGreaterThanOrEqual(result.stats.averageTokens);
    expect(result.stats.minTokens).toBeLessThanOrEqual(result.stats.averageTokens);
  });
});

const FIRST_HEADING_TEXT = 'First Heading';
const LEAD = 'This lead paragraph is the whole reason the document exists.';
const HEADED_BODY = `# ${FIRST_HEADING_TEXT}\n\nBody under the first heading.`;

/**
 * @param content - Markdown body, frontmatter included
 * @param headings - Heading nodes carrying 1-based lines into `content`
 * @returns A chunkable resource over that content
 */
function resourceOf(content: string, headings: HeadingNode[]): ChunkableResource {
  return {
    id: 'preamble-resource',
    filePath: '/preamble.md',
    content,
    contentHash: 'abc123',
    estimatedTokenCount: 20,
    links: [],
    headings,
    frontmatter: {},
  };
}

/**
 * @param line - 1-based line of the document's `# First Heading`
 * @returns The single-heading list every preamble case uses
 */
function firstHeadingAt(line: number): HeadingNode[] {
  return [{ level: 1, text: FIRST_HEADING_TEXT, slug: 'first-heading', line }];
}

/**
 * Everything above the first heading.
 *
 * A document that opens with an abstract, a TL;DR or a lead paragraph used to
 * index that prose at ZERO chunks: the section walk started AT the first
 * heading, so every byte above it was dropped with no error, no warning and no
 * counter. A retrieval index that silently omits a document's opening is worse
 * than one that refuses the document outright — nothing distinguishes "not in
 * this corpus" from "in this corpus and unfindable".
 *
 * The preamble carries NO heading metadata: not the first heading's, and not an
 * empty-string path that reads like one. It genuinely belongs to no section, and
 * a chunk labelled with a heading it sits ABOVE would be a worse lie than the
 * omission it replaces.
 */
describe('chunkResource preamble (content above the first heading)', () => {
  const config = {
    targetChunkSize: 512,
    modelTokenLimit: 8191,
    paddingFactor: 0.9,
    tokenCounter: new ApproximateTokenCounter(),
  };

  it('chunks a lead paragraph that sits above the first heading', () => {
    const result = chunkResource(
      resourceOf(`${LEAD}\n\n${HEADED_BODY}`, firstHeadingAt(3)),
      config,
    );

    expect(result.chunks.map((c) => c.content)).toContain(LEAD);
    expect(result.chunks).toHaveLength(2);
  });

  it('gives the preamble no heading path, so it cannot be read as the first section', () => {
    const result = chunkResource(
      resourceOf(`${LEAD}\n\n${HEADED_BODY}`, firstHeadingAt(3)),
      config,
    );

    const preamble = result.chunks[0];
    expect(preamble?.content).toBe(LEAD);
    expect(preamble?.headingPath).toBeUndefined();
    expect(preamble?.headingLevel).toBeUndefined();
    expect(preamble?.startLine).toBe(1);
    expect(preamble?.endLine).toBe(1);
  });

  it('keeps the lead paragraph and drops the frontmatter that precedes it', () => {
    const content = `---\ntitle: Test Doc\ntags: [a]\n---\n\n${LEAD}\n\n${HEADED_BODY}`;
    const result = chunkResource(resourceOf(content, firstHeadingAt(8)), config);

    const preamble = result.chunks[0];
    expect(preamble?.content).toBe(LEAD);
    expect(preamble?.startLine).toBe(6);
    expect(preamble?.endLine).toBe(6);
  });

  /**
   * `endLine` is the preamble's LAST prose line, not the blank below it and not
   * the line before the heading. A two-line lead makes the two ends differ, so
   * an `endLine` that merely echoed `startLine` — or was never set — fails here.
   */
  it('reports the line span of a multi-line preamble as its own first and last prose lines', () => {
    const content = `---\ntitle: Test Doc\n---\n\n${LEAD}\nAnd a second lead line.\n\n\n${HEADED_BODY}`;
    const result = chunkResource(resourceOf(content, firstHeadingAt(9)), config);

    const preamble = result.chunks[0];
    expect(preamble?.content).toBe(`${LEAD}\nAnd a second lead line.`);
    expect(preamble?.startLine).toBe(5);
    expect(preamble?.endLine).toBe(6);
  });

  /**
   * The section path `.trim()`s its content; the preamble path only trimmed
   * blank LINES, so a CRLF document's lead paragraph carried a trailing `\r`
   * into the embedded text — the one place the new path was less tidy than the
   * one beside it.
   */
  it('strips the carriage return a CRLF document leaves on the preamble', () => {
    const content = `---\r\ntitle: x\r\n---\r\n\r\n${LEAD}\r\n\r\n${HEADED_BODY.replaceAll('\n', '\r\n')}\r\n`;
    const result = chunkResource(resourceOf(content, firstHeadingAt(7)), config);

    const preamble = result.chunks[0];
    expect(preamble?.content).toBe(LEAD);
    expect(preamble?.content).not.toMatch(/\r/u);
    expect(preamble?.startLine).toBe(5);
    expect(preamble?.endLine).toBe(5);
  });

  /**
   * Leading spaces on the FIRST prose line are content: an indented code block
   * is one. A whole-string `.trim()` took them off that line alone (the second
   * line kept its indentation), so the embedded text was no longer the source
   * bytes. Only the trailing envelope — the `\r` of a CRLF last line, trailing
   * blanks — is removable; blank LINES were already excluded by line index.
   */
  it('keeps the indentation of a preamble that opens with an indented code block', () => {
    const preambleCode = '    code line one\n    code line two';
    const result = chunkResource(
      resourceOf(`${preambleCode}\n\n${HEADED_BODY}`, firstHeadingAt(4)),
      config,
    );

    const preamble = result.chunks[0];
    expect(preamble?.content).toBe(preambleCode);
    expect(preamble?.startLine).toBe(1);
    expect(preamble?.endLine).toBe(2);
  });

  it('keeps the indentation of a heading-less document that opens with an indented code block', () => {
    const body = '    indented first line\nplain second line';
    const result = chunkResource(resourceOf(`${body}\n`, []), config);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toBe(body);
    expect(result.chunks[0]?.startLine).toBe(1);
    expect(result.chunks[0]?.endLine).toBe(2);
  });

  it('emits no preamble chunk for a document that is only frontmatter and headings', () => {
    const content = `---\ntitle: Test Doc\n---\n\n${HEADED_BODY}`;
    const result = chunkResource(resourceOf(content, firstHeadingAt(5)), config);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.headingPath).toBe(FIRST_HEADING_TEXT);
  });

  it('emits no preamble chunk when the first heading is line 1', () => {
    const result = chunkResource(resourceOf(HEADED_BODY, firstHeadingAt(1)), config);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.headingPath).toBe(FIRST_HEADING_TEXT);
  });
});

/** Create a minimal ChunkableResource for enrichChunks tests */
function createResource(
  resourceId: string,
  filePath: string,
  overrides?: Partial<ChunkableResource>,
): ChunkableResource {
  return {
    id: resourceId,
    filePath,
    content: 'Test content',
    contentHash: 'abc123',
    estimatedTokenCount: 10,
    links: [],
    headings: [],
    frontmatter: {},
    ...overrides,
  };
}

describe('enrichChunks', () => {
  const TEST_RESOURCE_ID = 'test-resource';
  const TEST_MODEL = 'test-model';
  const TEST_FILE_PATH = '/test.md';

  it('should enrich raw chunks with RAGChunk metadata', () => {
    const resource = createResource(TEST_RESOURCE_ID, TEST_FILE_PATH, { frontmatter: { tags: ['test'], title: 'Test' } });

    const rawChunks = [
      { content: 'Chunk 1', headingPath: 'Section 1', headingLevel: 1 },
      { content: 'Chunk 2', headingPath: 'Section 2', headingLevel: 1 },
      { content: 'Chunk 3', headingPath: 'Section 3', headingLevel: 1 },
    ];

    const embeddings = [[0.1, 0.2], [0.3, 0.4], [0.5, 0.6]];

    const enriched = enrichChunks(rawChunks, resource, embeddings, TEST_MODEL);

    expect(enriched).toHaveLength(3);

    // Check first chunk
    expect(enriched[0]).toMatchObject({
      chunkId: `${TEST_RESOURCE_ID}-chunk-0`,
      resourceId: TEST_RESOURCE_ID,
      content: 'Chunk 1',
      filePath: TEST_FILE_PATH,
      tags: ['test'],
      title: 'Test',
      embeddingModel: TEST_MODEL,
      previousChunkId: undefined,
      nextChunkId: `${TEST_RESOURCE_ID}-chunk-1`,
    });

    // Check middle chunk
    expect(enriched[1]).toMatchObject({
      chunkId: `${TEST_RESOURCE_ID}-chunk-1`,
      previousChunkId: `${TEST_RESOURCE_ID}-chunk-0`,
      nextChunkId: `${TEST_RESOURCE_ID}-chunk-2`,
    });

    // Check last chunk
    expect(enriched[2]).toMatchObject({
      chunkId: `${TEST_RESOURCE_ID}-chunk-2`,
      previousChunkId: `${TEST_RESOURCE_ID}-chunk-1`,
      nextChunkId: undefined,
    });
  });

  it('should set tokenCount to 0 when no tokenCounter is provided', () => {
    const resource = createResource(TEST_RESOURCE_ID, TEST_FILE_PATH);
    const rawChunks = [
      { content: 'Some text content here' },
      { content: 'More text content here' },
    ];
    const embeddings = [[0.1, 0.2], [0.3, 0.4]];

    const enriched = enrichChunks(rawChunks, resource, embeddings, TEST_MODEL);

    expect(enriched[0]?.tokenCount).toBe(0);
    expect(enriched[1]?.tokenCount).toBe(0);
  });

  it('should populate tokenCount when tokenCounter is provided', () => {
    const resource = createResource(TEST_RESOURCE_ID, TEST_FILE_PATH);
    const rawChunks = [
      { content: 'Some text content here' },
      { content: 'A longer piece of text content that should have more tokens than the first chunk' },
    ];
    const embeddings = [[0.1, 0.2], [0.3, 0.4]];

    const counter = new ApproximateTokenCounter();
    const enriched = enrichChunks(rawChunks, resource, embeddings, TEST_MODEL, counter);

    // Token counts should be positive (not the default 0)
    expect(enriched[0]?.tokenCount).toBeGreaterThan(0);
    expect(enriched[1]?.tokenCount).toBeGreaterThan(0);

    // Token counts should match what the counter returns directly
    expect(enriched[0]?.tokenCount).toBe(counter.count(rawChunks[0]?.content ?? ''));
    expect(enriched[1]?.tokenCount).toBe(counter.count(rawChunks[1]?.content ?? ''));

    // Second chunk should have more tokens than the first
    expect(enriched[1]?.tokenCount).toBeGreaterThan(enriched[0]?.tokenCount ?? 0);
  });

  it('should populate chunkIndex and totalChunks', () => {
    const resource = createResource(TEST_RESOURCE_ID, TEST_FILE_PATH);
    const rawChunks = [{ content: 'A' }, { content: 'B' }, { content: 'C' }];
    const embeddings = [[1], [2], [3]];

    const enriched = enrichChunks(rawChunks, resource, embeddings, TEST_MODEL);

    expect(enriched).toHaveLength(3);
    for (const [i, chunk] of enriched.entries()) {
      expect(chunk.chunkIndex).toBe(i);
      expect(chunk.totalChunks).toBe(3);
    }
  });

  it('should handle single chunk correctly', () => {
    const resource = createResource(TEST_RESOURCE_ID, TEST_FILE_PATH, { content: 'Test', estimatedTokenCount: 5 });
    const rawChunks = [{ content: 'Single chunk' }];
    const embeddings = [[0.1, 0.2]];

    const enriched = enrichChunks(rawChunks, resource, embeddings, TEST_MODEL);

    expect(enriched).toHaveLength(1);
    expect(enriched[0]?.previousChunkId).toBeUndefined();
    expect(enriched[0]?.nextChunkId).toBeUndefined();
    expect(enriched[0]?.chunkIndex).toBe(0);
    expect(enriched[0]?.totalChunks).toBe(1);
  });
});

/**
 * Frontmatter is metadata, and it is metadata whether or not a heading follows it.
 *
 * The preamble path above strips a leading YAML fence before chunking. The
 * no-headings path did not — it handed `chunkByTokens` the whole file, fence
 * included. So the SAME body indexed differently depending on whether someone
 * had written a `#` into it: with a heading, the YAML was dropped; without one,
 * the YAML became retrievable prose that outweighed the two lines of real
 * content around it. Nobody chose that; it fell out of two code paths that had
 * only one of them taught about frontmatter.
 *
 * Making them consistent has a consequence worth stating out loud: a document
 * that is ONLY frontmatter now produces ZERO chunks. That is the right answer —
 * there is no prose to retrieve, and an index entry whose content is a YAML
 * fence answers no query anyone will ask — but it puts a zero-chunk document on
 * a path that must be honest rather than arithmetically broken, which is what
 * the statistics suite below pins.
 */
describe('chunkResource frontmatter handling without headings', () => {
  const config = {
    targetChunkSize: 512,
    modelTokenLimit: 8191,
    paddingFactor: 0.9,
    tokenCounter: new ApproximateTokenCounter(),
  };

  const HEADLESS_BODY = 'Plain prose with no heading anywhere in it.';
  const FRONTMATTER = '---\ntitle: Test Doc\ntags: [a]\n---';

  it('drops a leading frontmatter fence from a document that has no headings', () => {
    const result = chunkResource(
      resourceOf(`${FRONTMATTER}\n\n${HEADLESS_BODY}`, []),
      config,
    );

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toBe(HEADLESS_BODY);
    // 1-based: the fence occupies lines 1-4, line 5 is blank.
    expect(result.chunks[0]?.startLine).toBe(6);
  });

  /**
   * The consistency property itself, rather than one side of it.
   *
   * Same frontmatter, same prose; the only difference is a heading underneath.
   * Before the fix the headless arm carried the YAML and the headed arm did not,
   * so this comparison failed on the first chunk's content.
   */
  it('indexes the same lead prose identically with and without a following heading', () => {
    const headless = chunkResource(
      resourceOf(`${FRONTMATTER}\n\n${HEADLESS_BODY}`, []),
      config,
    );
    const headed = chunkResource(
      resourceOf(`${FRONTMATTER}\n\n${HEADLESS_BODY}\n\n${HEADED_BODY}`, firstHeadingAt(8)),
      config,
    );

    expect(headless.chunks[0]?.content).toBe(HEADLESS_BODY);
    expect(headed.chunks[0]?.content).toBe(headless.chunks[0]?.content);
  });

  it('produces no chunks at all for a document that is only frontmatter', () => {
    const result = chunkResource(resourceOf(FRONTMATTER, []), config);

    expect(result.chunks).toHaveLength(0);
  });

  /**
   * An unterminated opening fence is a thematic break, not frontmatter — the
   * discriminator the preamble path already applies. Without this control, a
   * "fix" that simply skipped any leading `---` line would pass everything above
   * while silently eating the first line of every document that opens with a
   * horizontal rule.
   */
  it('keeps a leading thematic break that never closes, because it is not frontmatter', () => {
    const result = chunkResource(resourceOf(`---\n\n${HEADLESS_BODY}`, []), config);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain('---');
  });

  /**
   * What counts as frontmatter is the PARSER's call, not the chunker's. The
   * heading lines the chunker slices by come from remark-frontmatter, which
   * closes a YAML block on `---` only; a YAML document-end marker (`...`) is
   * prose to it, and so is everything above it. A chunker that also closed on
   * `...` silently dropped three lines the parser had classified as content.
   */
  it('does not close frontmatter on a YAML document-end marker, because the parser does not', () => {
    const content = `---\ntitle: x\n...\n\n${HEADLESS_BODY}`;
    const result = chunkResource(resourceOf(content, []), config);

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toBe(content);
    expect(result.chunks[0]?.startLine).toBe(1);
    expect(result.chunks[0]?.endLine).toBe(5);
  });

  it('strips the carriage return a CRLF document leaves on headless prose', () => {
    const result = chunkResource(
      resourceOf(`---\r\ntitle: x\r\n---\r\n\r\n${HEADLESS_BODY}\r\n`, []),
      config,
    );

    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toBe(HEADLESS_BODY);
    expect(result.chunks[0]?.startLine).toBe(5);
    expect(result.chunks[0]?.endLine).toBe(5);
  });
});

/**
 * A zero-chunk document must report zero, not `NaN` and not `-Infinity`.
 *
 * `averageTokens` divided by `rawChunks.length`, and `Math.max(...[])` is
 * `-Infinity` (`Math.min(...[])` is `+Infinity`). An empty document reached that
 * arithmetic before this change, and a frontmatter-only document reaches it now
 * that the two chunking paths agree — so the statistic a caller reads for a
 * document that legitimately yields nothing has to be a number.
 *
 * The JSON round-trip is the load-bearing assertion, not decoration: `NaN` and
 * `±Infinity` are not JSON values, so `JSON.stringify` writes them as `null`.
 * Any report that serializes these statistics would therefore publish `null`
 * where a reader expects a count — a defect that never surfaces in-process.
 */
describe('chunkResource statistics for a document that yields no chunks', () => {
  const config = {
    targetChunkSize: 512,
    modelTokenLimit: 8191,
    paddingFactor: 0.9,
    tokenCounter: new ApproximateTokenCounter(),
  };

  it('reports zero for every statistic when nothing was chunked', () => {
    const result = chunkResource(resourceOf('', []), config);

    expect(result.chunks).toHaveLength(0);
    expect(result.stats).toEqual({
      totalChunks: 0,
      averageTokens: 0,
      maxTokens: 0,
      minTokens: 0,
    });
  });

  it('serializes as numbers, which NaN and +/-Infinity do not', () => {
    const { stats } = chunkResource(resourceOf('', []), config);

    // The in-process property: every statistic is a finite number. `NaN` and
    // `+/-Infinity` are numbers too, and `typeof` cannot tell them apart.
    expect(Object.values(stats).every((value) => Number.isFinite(value))).toBe(true);

    // The same property at the boundary where it actually bites. None of the
    // three is a JSON value, so `JSON.stringify` writes each as `null` — a
    // published report would show `null` where a reader expects a count.
    expect(JSON.stringify(stats)).not.toContain('null');
  });

  it('still reports real numbers for a document that does chunk', () => {
    const { stats } = chunkResource(resourceOf(HEADED_BODY, firstHeadingAt(1)), config);

    expect(stats.totalChunks).toBe(1);
    expect(stats.averageTokens).toBeGreaterThan(0);
    expect(stats.maxTokens).toBeGreaterThan(0);
    expect(stats.minTokens).toBeGreaterThan(0);
  });
});
