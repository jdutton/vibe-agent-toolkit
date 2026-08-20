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


import { getTestOutputDir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * Parse the CLI's YAML output.
 *
 * The CLI emits ONE YAML document — an optional `---` opener followed by the
 * body, to the end of stdout. This helper used to require a CLOSING `---` too,
 * which encoded a real defect: emitting both markers made stdout two YAML
 * documents, so a consumer calling plain `YAML.parse()` on it threw. When the
 * trailing marker was removed, this pattern stopped matching and reported
 * `expected null to be truthy` — the test failing because the product was fixed.
 *
 * Everything after the opener is taken as the document; the field assertions in
 * each test are what verify the content.
 *
 * @param result - Spawn sync result from CLI command
 * @returns Parsed YAML output
 */
function parseYamlOutput(result: SpawnSyncReturns<string>): unknown {
  const opener = /^---\n/m.exec(result.stdout);
  const body = opener ? result.stdout.slice(opener.index + opener[0].length) : result.stdout;
  expect(body.trim()).not.toBe('');
  return parse(body);
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

  // A process killed by the timeout never exits, so `status` is null and
  // `expect(result.status).toBe(0)` reports "expected null to be +0" — a message
  // that names neither the timeout nor the command, three frames from the cause.
  // Checked before the status assertion so the timeout reports itself as one.
  if (result.error !== undefined) {
    const killedBy = result.signal === null ? '' : ` (killed by ${result.signal})`;
    const budget = timeout === undefined ? '' : `, budget ${timeout}ms`;
    throw new Error(
      `node ${args.join(' ')} did not run to completion: ${result.error.message}${killedBy}${budget}`
    );
  }

  expect(result.status).toBe(0);
  return parseYamlOutput(result);
}

// Runs on all platforms including macOS. The RAG CLI's default embedding backend
// is onnxruntime-web (WASM), which has no native static destructors, so it no
// longer races LanceDB's native runtime at process teardown. (This repo's CI
// matrix has no macOS runner, so this specific SIGABRT / exit 134 abort was
// never caught by CI — it only affected local development on a Mac. There was
// no skip guard here to remove; the fix is that the abort no longer happens.)
describe('RAG CLI (Node.js dogfooding)', () => {
  const projectRoot = safePath.resolve(__dirname, '../../../..');
  const binPath = safePath.join(projectRoot, 'packages/cli/dist/bin.js');
  // Use isolated test output directory to avoid conflicts in parallel test execution
  const testDbPath = getTestOutputDir('rag-lancedb', 'system', 'test-db');
  // Index only architecture docs (5 files) instead of all docs (53 files) for faster tests
  const docsPath = safePath.join(projectRoot, 'docs/architecture');

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
      // ⚠️ A FIXED budget over a corpus that GROWS. `docsPath` is the live
      // `docs/architecture` directory, so this test gets slower every time
      // anyone documents the architecture — it is not "only 5 docs", and no
      // number written here stays correct.
      //
      // Measured 2026-08-19 on an idle macOS host, varying ONLY the corpus and
      // holding the binary fixed:
      //
      //     7 docs (116 KB)  216 chunks  26.4s   122.2 ms/chunk
      //    12 docs (276 KB)  374 chunks  45.4s   121.4 ms/chunk
      //
      // Cost is `chunks × ~121 ms` — linear, with a near-zero intercept. Two
      // consequences, both of which contradict what this comment used to say:
      //
      //  - It is NOT dominated by loading the onnxruntime-web WASM backend in a
      //    fresh process. Rates that agree to 0.7% across a 1.7x corpus leave no
      //    room for a large fixed cost, and `rag query` — also a fresh process,
      //    also embedding — returns in ~880ms. So making the backend
      //    warm-startable would NOT fix this; there is no startup to warm.
      //  - It is NOT a flake, and rerunning is not a diagnosis. Observed red
      //    3-of-3 on ubuntu across two trees, and on windows, which runs system
      //    tests SERIALLY (`maxForks: 1`) — so concurrency is not required to
      //    blow the budget, though it does subtract headroom.
      //
      // 60,000ms buys ~495 chunks here and fewer on CI hardware, which reddens
      // at 374. Raising the number only moves the next failure; the corpus keeps
      // growing. The fix is to stop measuring an unbounded input — pin this to a
      // fixture — which trades away dogfooding the real docs tree and is
      // therefore a product call, not a test-maintenance one.
      60000 // ~495 chunks locally; the live corpus is at 374 and climbing
    );

    expect(output.status).toBe('success');
    expect(output.resourcesIndexed).toBeGreaterThan(0);
    expect(output.chunksCreated).toBeGreaterThan(0);
  }, 60000);

  it('should query indexed documentation via CLI', () => {
    const output = executeCliCommand(
      binPath,
      ['rag', 'query', 'How do I configure RAG?', '--db', testDbPath, '--limit', '5'],
      projectRoot,
      30000 // 30 seconds for query with embedding
    );

    expect(output.status).toBe('success');
    expect(output.chunks.length).toBeGreaterThan(0);
    expect(output.stats.totalMatches).toBeGreaterThan(0);
  });

  it('should show database statistics via CLI', () => {
    const output = executeCliCommand(binPath, ['rag', 'stats', '--db', testDbPath], projectRoot, 10000);

    expect(output.status).toBe('success');
    expect(output.totalChunks).toBeGreaterThan(0);
    expect(output.totalResources).toBeGreaterThan(0);
    expect(output.embeddingModel).toBeTruthy();
  });

  it('should find relevant chunks for configuration questions', () => {
    const output = executeCliCommand(
      binPath,
      ['rag', 'query', 'RAG configuration and setup', '--db', testDbPath, '--limit', '5'],
      projectRoot,
      30000 // 30 seconds for query with embedding
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
    const output = executeCliCommand(binPath, ['rag', 'clear', '--db', testDbPath], projectRoot, 10000);

    expect(output.status).toBe('success');

    // Verify database is gone
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDbPath is from controlled projectRoot constant
    expect(existsSync(testDbPath)).toBe(false);
  });
});
