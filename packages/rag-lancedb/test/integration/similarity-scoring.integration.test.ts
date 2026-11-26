/**
 * Integration tests for similarity scoring (BUG #3)
 *
 * Tests that vector search results include distance metrics for ranking and filtering.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { onnxModelUnreachable } from '../../../rag/test/onnx-model-gate.js';
import {
  createTestMarkdownFile,
  createTestResource,
  setupLanceDBTestSuite,
  suiteProvider,
} from '../test-helpers.js';


// The suite embeds with the local ONNX model, fetched from huggingface.co on a cache miss.
describe.skipIf(onnxModelUnreachable())('Similarity Scoring', () => {
  const suite = setupLanceDBTestSuite(true);

  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should include distance metric in search results', async () => {
    // RED: This test will FAIL because _distance is not exposed

    // Create and index a document
    const testFile = await createTestMarkdownFile( suite.tempDir,
      'test.md',
      `# Authentication Guide

Authentication is the process of verifying user identity.
Common methods include passwords, OAuth, and multi-factor authentication.

# Authorization

Authorization determines what authenticated users can access.
Role-based access control (RBAC) is a common pattern.`
    );

    const resource = await createTestResource(testFile, 'auth-doc');
    await suiteProvider(suite).indexResources([resource], suite.objects);

    // Query for authentication
    const result = await suiteProvider(suite).query({
      text: 'authentication methods',
      limit: 5,
    });

    expect(result.chunks.length).toBeGreaterThan(0);

    // BUG: _distance field is not included in results
    const firstChunk = result.chunks[0];
    if (firstChunk === undefined) throw new Error('the query returned no chunk');

    // Check for distance metric (raw value from LanceDB)
    expect(firstChunk).toHaveProperty('_distance');
    expect(typeof firstChunk._distance).toBe('number');
    expect(firstChunk._distance).toBeGreaterThanOrEqual(0);
  });

  it('should include computed similarity score in results', async () => {
    // RED: This test will FAIL because score is not computed

    const testFile = await createTestMarkdownFile( suite.tempDir,
      'test.md',
      `# Database Design

Relational databases use tables with foreign keys.
NoSQL databases include document stores, key-value stores, and graph databases.`
    );

    const resource = await createTestResource(testFile, 'db-doc');
    await suiteProvider(suite).indexResources([resource], suite.objects);

    const result = await suiteProvider(suite).query({
      text: 'database types',
      limit: 3,
    });

    expect(result.chunks.length).toBeGreaterThan(0);

    // BUG: score field is not computed or included
    const firstChunk = result.chunks[0];
    if (firstChunk === undefined) throw new Error('the query returned no chunk');

    // Check for similarity score (0-1 range, higher is better)
    expect(firstChunk).toHaveProperty('score');
    expect(typeof firstChunk.score).toBe('number');
    expect(firstChunk.score).toBeGreaterThan(0);
    expect(firstChunk.score).toBeLessThanOrEqual(1);
  });

  it('should allow filtering results by minimum score threshold', async () => {
    // RED: This test will FAIL because scores aren't available for filtering

    const testFile = await createTestMarkdownFile( suite.tempDir,
      'test.md',
      `# Microservices

Microservices architecture decomposes applications into small, independent services.

# Monolithic Architecture

Monolithic applications are built as a single unit with tightly coupled components.

# Serverless Computing

Serverless platforms abstract infrastructure management entirely.`
    );

    const resource = await createTestResource(testFile, 'arch-doc');
    await suiteProvider(suite).indexResources([resource], suite.objects);

    // Query with high relevance requirement
    const result = await suiteProvider(suite).query({
      text: 'microservices architecture patterns',
      limit: 10,
    });

    expect(result.chunks.length).toBeGreaterThan(0);

    // User wants to filter by confidence threshold
    // Note: Semantic search scores vary; 0.5 is a reasonable minimum for relevance
    const MIN_SCORE_THRESHOLD = 0.5;

    // BUG: Can't filter by score because it's not available
    const highConfidenceResults = result.chunks.filter(
      (chunk) => (chunk.score ?? 0) >= MIN_SCORE_THRESHOLD
    );

    // Should have at least one high-confidence result for exact match
    expect(highConfidenceResults.length).toBeGreaterThan(0);

    // All results should meet threshold
    for (const chunk of highConfidenceResults) {
      expect(chunk.score).toBeGreaterThanOrEqual(MIN_SCORE_THRESHOLD);
    }
  });

  it('should rank results by descending similarity score', async () => {
    // RED: This test will FAIL because scores aren't available for ranking verification

    const testFile = await createTestMarkdownFile( suite.tempDir,
      'test.md',
      `# Python Programming

Python is a high-level programming language with dynamic typing.
Popular for data science, web development, and automation.

# JavaScript Basics

JavaScript runs in browsers and on Node.js servers.
Used for interactive web applications.

# Ruby on Rails

Rails is a web framework written in Ruby.
Follows convention over configuration.`
    );

    const resource = await createTestResource(testFile, 'prog-doc');
    await suiteProvider(suite).indexResources([resource], suite.objects);

    const result = await suiteProvider(suite).query({
      text: 'Python programming data science',
      limit: 5,
    });

    expect(result.chunks.length).toBeGreaterThan(1);

    // BUG: Can't verify ranking because scores aren't exposed
    // Results should be ordered by descending score
    for (let i = 1; i < result.chunks.length; i++) {
      const prevScore = result.chunks[i - 1]?.score ?? 0;
      const currScore = result.chunks[i]?.score ?? 0;

      expect(prevScore).toBeGreaterThanOrEqual(currScore);
    }
  });
});
