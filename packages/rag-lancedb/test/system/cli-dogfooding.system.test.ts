/**
 * CLI system tests (Node.js-based dogfooding)
 *
 * These tests run the actual CLI commands with Node.js runtime to avoid
 * the Bun + Arrow buffer issue. They provide true end-to-end testing.
 *
 * Related Issues:
 * - Apache Arrow buffer issues: https://github.com/apache/arrow/issues/35355
 * - LanceDB JS issues: https://github.com/lancedb/lancedb/issues/882
 * - Arrow memory docs: https://arrow.apache.org/docs/python/api/memory.html
 *
 * The "Buffer is already detached" error occurs in Bun when querying LanceDB
 * after table modifications. CLI tests with Node.js provide equivalent coverage.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { getTestOutputDir } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Parse YAML output from CLI command (between --- markers)
 * @param result - Spawn sync result from CLI command
 * @returns Parsed YAML output
 */
function parseYamlOutput(result: SpawnSyncReturns<string>): unknown {
  const yamlMatch = /---\n([\S\s]*?)\n---/.exec(result.stdout);
  expect(yamlMatch).toBeTruthy();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- yamlMatch checked by expect above
  return parse(yamlMatch![1]!);
}

/**
 * Execute CLI command and parse YAML output
 * @param binPath - Path to CLI binary
 * @param args - CLI arguments
 * @param projectRoot - Project root directory
 * @param timeout - Optional timeout in milliseconds
 * @returns Parsed YAML output
 */
function executeCliCommand(
  binPath: string,
  args: string[],
  projectRoot: string,
  timeout?: number
): unknown {
  // Use 'node' from PATH - safe in test context where PATH is controlled by test environment
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- node executable from PATH is required for CLI testing
  const result = spawnSync('node', [binPath, ...args], {
    encoding: 'utf-8',
    cwd: projectRoot,
    timeout,
  });

  expect(result.status).toBe(0);
  return parseYamlOutput(result);
}

describe('RAG CLI (Node.js dogfooding)', () => {
  const projectRoot = resolve(__dirname, '../../../..');
  const binPath = join(projectRoot, 'packages/cli/dist/bin.js');
  // Use isolated test output directory to avoid conflicts in parallel test execution
  const testDbPath = getTestOutputDir('rag-lancedb', 'system', 'test-db');
  const docsPath = join(projectRoot, 'docs');

  beforeAll(async () => {
    // Ensure CLI is built
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- binPath is from controlled projectRoot constant
    if (!existsSync(binPath)) {
      throw new Error('CLI not built. Run: bun run build');
    }

    // Clean up any existing test database
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDbPath is from controlled projectRoot constant
    if (existsSync(testDbPath)) {
      await rm(testDbPath, { recursive: true, force: true });
    }
  }, 60000);

  afterAll(async () => {
    // Clean up test database
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDbPath is from controlled projectRoot constant
    if (existsSync(testDbPath)) {
      await rm(testDbPath, { recursive: true, force: true });
    }
  });

  it('should index project documentation via CLI', () => {
    const output = executeCliCommand(
      binPath,
      ['rag', 'index', docsPath, '--db', testDbPath],
      projectRoot,
      60000
    );

    expect(output.status).toBe('success');
    expect(output.resourcesIndexed).toBeGreaterThan(0);
    expect(output.chunksCreated).toBeGreaterThan(0);
  }, 60000);

  it('should query indexed documentation via CLI', () => {
    const output = executeCliCommand(
      binPath,
      ['rag', 'query', 'How do I configure RAG?', '--db', testDbPath, '--limit', '5'],
      projectRoot
    );

    expect(output.status).toBe('success');
    expect(output.chunks.length).toBeGreaterThan(0);
    expect(output.stats.totalMatches).toBeGreaterThan(0);
  });

  it('should show database statistics via CLI', () => {
    const output = executeCliCommand(binPath, ['rag', 'stats', '--db', testDbPath], projectRoot);

    expect(output.status).toBe('success');
    expect(output.totalChunks).toBeGreaterThan(0);
    expect(output.totalResources).toBeGreaterThan(0);
    expect(output.embeddingModel).toBeTruthy();
  });

  it('should find relevant chunks for configuration questions', () => {
    const output = executeCliCommand(
      binPath,
      ['rag', 'query', 'RAG configuration and setup', '--db', testDbPath, '--limit', '5'],
      projectRoot
    );

    expect(output.chunks.length).toBeGreaterThan(0);

    // Verify relevance - should find docs about RAG/config
    const hasRelevantContent = output.chunks.some((chunk: { content: string }) => {
      const content = chunk.content.toLowerCase();
      return content.includes('rag') || content.includes('config') || content.includes('provider');
    });

    expect(hasRelevantContent).toBe(true);
  });

  it('should clear database via CLI', () => {
    const output = executeCliCommand(binPath, ['rag', 'clear', '--db', testDbPath], projectRoot);

    expect(output.status).toBe('success');

    // Verify database is gone
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDbPath is from controlled projectRoot constant
    expect(existsSync(testDbPath)).toBe(false);
  });
});
