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

/** Where the CLI lives and which database it should be pointed at. */
interface CliTarget {
  binPath: string;
  dbPath: string;
  projectRoot: string;
}

/**
 * Query the fixture corpus and return the resourceId of the single top hit.
 *
 * `--limit 1` is load-bearing. A limit at or above the corpus size makes
 * `chunks.length > 0` unfalsifiable: every chunk comes back, in any order,
 * with any embedder — so the assertion passes over a broken ranker and even
 * over a broken embedder. (Measured: with ranking replaced by an unordered
 * table scan, `--limit 5` still returned 5 chunks.) Asking for exactly one
 * hit forces the corpus to be ranked, and naming the document that must win
 * is the part that can actually fail. That the index is non-empty at all is
 * already asserted by the index test and the stats test.
 *
 * @param cli - CLI binary, database and working directory to run against
 * @param query - Natural-language query to run through the CLI
 * @returns resourceId of the highest-ranked chunk
 */
function queryTopResourceId(cli: CliTarget, query: string): string {
  const output = executeCliCommand(
    cli.binPath,
    ['rag', 'query', query, '--db', cli.dbPath, '--limit', '1'],
    cli.projectRoot,
    30000 // 30 seconds for query with embedding
  ) as { status: string; stats: { totalMatches: number }; chunks: { resourceId: string }[] };

  expect(output.status).toBe('success');
  expect(output.stats.totalMatches).toBe(1);
  expect(output.chunks.length).toBe(1);

  const [topHit] = output.chunks;
  return topHit.resourceId;
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
  // A FIXED corpus, deliberately not the live `docs/architecture`. Cost is
  // `chunks × ~121 ms`, so indexing a directory that grows as the repo documents
  // itself put a fixed budget over an unbounded input — it reddened on both CI
  // platforms once the corpus reached 374 chunks. A fixture keeps the budget
  // meaningful, and the pinned count below turns a chunking regression into a
  // named failure instead of somebody else's timeout.
  //
  // The corpus is small but NOT uniformly small: `chunk-sizing.md` carries one
  // section long enough to exceed the effective target size, which is what
  // makes the pinned count sensitive to the token splitter (see the index test).
  //
  // Deliberately NOT named `test/fixtures/...`: this project's own
  // `vibe-agent-toolkit.config.yaml` excludes `**/test/fixtures/**` and
  // `**/test-fixtures/**` from resource crawling (that pattern means "test
  // input, not real content" — e.g. deliberately-broken skill-eval fixtures),
  // and `rag index <path>` applies that exclude to explicit path arguments
  // too (see `crawlOptionsForPath` in `packages/cli/src/utils/resource-loader.ts`).
  // A directory named `test/fixtures/rag-corpus` is invisible to the crawler
  // and silently indexes zero resources — this corpus IS meant to be indexed,
  // so it lives under a path the exclude doesn't match.
  const docsPath = safePath.join(__dirname, '../rag-corpus-fixture');
  const cli: CliTarget = { binPath, dbPath: testDbPath, projectRoot };

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
      // A fixed fixture corpus, so this budget is a hang-detector rather than a
      // performance assertion. Cost is `chunks × ~121 ms`; the pinned
      // `chunksCreated` below is what actually guards regressions.
      30000
    );

    expect(output.status).toBe('success');
    expect(output.resourcesIndexed).toBe(5);
    // Pinned, not `> 0`: a chunker change is the thing most likely to move
    // indexing cost, and `> 0` cannot see it.
    //
    // What the 8 is made of, and why it is not just a file count:
    //   5 heading-section chunks — `overview.md` has two headings,
    //     `configuration.md`, `glossary.md` and `retrieval.md` one each, and
    //     every one of those sections is short enough to survive whole;
    //   3 token-split chunks — `chunk-sizing.md` is a single ~1110-token
    //     section, well past the effective target (`targetChunkSize` 512 ×
    //     `paddingFactor` 0.9 = 460), so `chunkByTokens` divides it.
    //
    // That second term is the entire point of `chunk-sizing.md`.
    // `chunkResource` is a HYBRID: it splits on heading boundaries first and
    // calls `chunkByTokens` only for sections over the target. A corpus whose
    // sections are all a few lines long therefore pins a PURE HEADING COUNT —
    // the token path is never entered, and `targetChunkSize` could be changed
    // to anything at all without moving the number. That was measured, not
    // assumed: over the four short files this fixture started as, indexing
    // reported 5 chunks at `targetChunkSize` 64 AND at 2048, identically.
    // With `chunk-sizing.md` in the corpus the count now tracks the setting:
    // 64 → 29, 512 → 8, 2048 → 6 (the long section fits whole again).
    //
    // If this number changes, decide whether the chunker change was intended —
    // do not simply update it.
    expect(output.chunksCreated).toBe(8);
  }, 30000);

  it('should query indexed documentation via CLI', () => {
    // Targets `retrieval.md`, which is the only document about matching a
    // query against stored vectors. The corpus also holds `chunk-sizing.md`,
    // which discusses embeddings and retrieval at length and outweighs every
    // other file — so passing means ranking a longer, topically adjacent
    // document below a shorter, on-topic one.
    expect(queryTopResourceId(cli, 'How is a search query matched against stored vectors?')).toMatch(
      /retrieval-md$/
    );
  });

  it('should show database statistics via CLI', () => {
    const output = executeCliCommand(binPath, ['rag', 'stats', '--db', testDbPath], projectRoot, 10000);

    expect(output.status).toBe('success');
    expect(output.totalChunks).toBeGreaterThan(0);
    expect(output.totalResources).toBeGreaterThan(0);
    expect(output.embeddingModel).toBeTruthy();
  });

  it('should find relevant chunks for configuration questions', () => {
    // A real ranking assertion for the same reason as the test above: the
    // corpus also holds `overview.md`, `glossary.md`, `retrieval.md` and
    // `chunk-sizing.md`, so the query must actually outrank all of them.
    expect(queryTopResourceId(cli, 'RAG configuration and setup')).toMatch(/configuration-md$/);
  });

  it('should clear database via CLI', () => {
    const output = executeCliCommand(binPath, ['rag', 'clear', '--db', testDbPath], projectRoot, 10000);

    expect(output.status).toBe('success');

    // Verify database is gone
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- testDbPath is from controlled projectRoot constant
    expect(existsSync(testDbPath)).toBe(false);
  });
});
