/**
 * Integration tests for line number tracking (BUG #7)
 *
 * Tests that chunks preserve precise line number ranges from source documents.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestMarkdownFile, createTestResource, setupLanceDBTestSuite } from '../test-helpers.js';

describe('Line Number Tracking', () => {
  const suite = setupLanceDBTestSuite(true);

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should track line numbers for each chunk', async () => {
    // RED: This test will FAIL because chunks don't have per-chunk line ranges

    // Create a multi-line document that will be split into multiple chunks
    const testFile = await createTestMarkdownFile(
      suite.tempDir,
      'multiline.md',
      `# Section 1
Line 2 content here.
Line 3 more content.
Line 4 even more content to ensure chunking.
Line 5 continues the section.

# Section 2
Line 8 starts second section.
Line 9 has different content.
Line 10 adds more information.
Line 11 includes technical details.

# Section 3
Line 14 begins final section.
Line 15 wraps up the document.
Line 16 provides closing remarks.`
    );

    const resource = await createTestResource(testFile, 'multiline-doc');
    await suite.provider.indexResources([resource]);

    const result = await suite.provider.query({
      text: 'second section',
      limit: 10,
    });

    expect(result.chunks.length).toBeGreaterThan(0);

    // BUG: Chunks don't have accurate per-chunk line ranges
    // All chunks from same resource get same startLine/endLine (resource-level, not chunk-level)
    const chunk = result.chunks.find((c) => c.content.includes('second section'));
    expect(chunk).toBeDefined();

    // Should have precise line numbers for this specific chunk
    expect(chunk?.startLine).toBeDefined();
    expect(chunk?.endLine).toBeDefined();

    // Section 2 starts at line 7 ("# Section 2"), so startLine should be around 7-8
    // Not line 1 (which would indicate resource-level tracking, not chunk-level)
    expect(chunk?.startLine).toBeGreaterThan(5); // Should NOT be 1 or 2
    expect(chunk?.startLine).toBeLessThan(12); // Should be in Section 2 range

    // endLine should be after startLine and before Section 3
    if (chunk?.startLine !== undefined) {
      expect(chunk.endLine).toBeGreaterThan(chunk.startLine);
    }
    expect(chunk?.endLine).toBeLessThan(14); // Before Section 3
  });

  it('should maintain line number ordering across chunks', async () => {
    // RED: This test will FAIL because all chunks have same line ranges

    // Create a document long enough to split into multiple chunks (>2048 characters for chunking)
    const longContent = Array.from({ length: 50 }, (_, i) =>
      `Line ${i + 1}: This is detailed content for line ${i + 1} with extensive information about various topics including methodology, results, analysis, and conclusions. This line contains enough text to ensure the document reaches the chunking threshold and gets split into multiple distinct chunks with different line number ranges.`
    ).join('\n');

    const testFile = await createTestMarkdownFile(
      suite.tempDir,
      'ordered.md',
      longContent
    );

    const resource = await createTestResource(testFile, 'ordered-doc');
    await suite.provider.indexResources([resource]);

    const result = await suite.provider.query({
      text: 'information',
      limit: 10,
    });

    expect(result.chunks.length).toBeGreaterThan(1);

    // BUG: All chunks will have same startLine/endLine (resource-level)
    // They should have sequential, non-overlapping line ranges

    // Verify chunks have increasing line numbers (no overlaps)
    const sortedChunks = result.chunks
      .filter((c) => c.startLine !== undefined)
      .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));

    for (let i = 1; i < sortedChunks.length; i++) {
      const prevChunk = sortedChunks[i - 1];
      const currChunk = sortedChunks[i];

      // Current chunk should start after previous chunk ends
      if (prevChunk && prevChunk.endLine !== undefined && currChunk.startLine !== undefined) {
        expect(currChunk.startLine).toBeGreaterThan(prevChunk.endLine);
      }
    }
  });

  it('should enable precise source navigation', async () => {
    // RED: This test will FAIL because we can't navigate to specific lines

    const testFile = await createTestMarkdownFile(
      suite.tempDir,
      'navigation.md',
      `# API Documentation

## Authentication

Line 5: Use Bearer token authentication.
Line 6: Include token in Authorization header.
Line 7: Format: "Authorization: Bearer <token>"

## Rate Limiting

Line 11: API has rate limits of 100 requests per minute.
Line 12: Exceeding limits returns 429 Too Many Requests.
Line 13: Use exponential backoff for retries.`
    );

    const resource = await createTestResource(testFile, 'api-doc');
    await suite.provider.indexResources([resource]);

    // User searches for rate limiting info
    const result = await suite.provider.query({
      text: 'rate limits requests per minute',
      limit: 5,
    });

    const relevantChunk = result.chunks.find((c) => c.content.includes('rate limits'));
    expect(relevantChunk).toBeDefined();

    // Debug: Log actual line numbers
    console.log('Relevant chunk line numbers:', {
      startLine: relevantChunk?.startLine,
      endLine: relevantChunk?.endLine,
      contentPreview: relevantChunk?.content.substring(0, 100),
    });

    // BUG: Can't provide accurate IDE navigation because line numbers are resource-level
    // Should be able to tell user: "Found at lines 11-13"
    // Instead only know: "Found somewhere in this file"

    expect(relevantChunk?.startLine).toBeDefined();
    expect(relevantChunk?.endLine).toBeDefined();

    // Rate limiting section is lines 11-13
    expect(relevantChunk?.startLine).toBeGreaterThanOrEqual(9);
    expect(relevantChunk?.startLine).toBeLessThanOrEqual(11);
    expect(relevantChunk?.endLine).toBeGreaterThanOrEqual(12);
    expect(relevantChunk?.endLine).toBeLessThanOrEqual(15);
  });
});
