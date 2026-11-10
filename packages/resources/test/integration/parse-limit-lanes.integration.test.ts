/**
 * A parse stopped at a limit, as each crawl lane reports it (ADR I6, I8).
 *
 * Three documents, the middle one a real breach (it recurses past a 1 MiB stack).
 * On both lanes the run completes, the breach is refused naming the file and the
 * limit, the other two documents keep every row, nothing about the breach is
 * stored — no parse-cache entry, no storable condition — and the next run
 * parses the breached document again.
 */

import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';
import { safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ParseCache } from '../../src/parse-cache.js';
import type { ParsePoolPolicy } from '../../src/parse-dispatcher.js';
import { __setParseWorkerEntryForTest, createParsePool, type ParsePool, type ParsePoolOptions } from '../../src/parse-pool.js';
import {
  BLOB_PARSE_FAILED,
  BLOB_PARSE_LIMIT_EXCEEDED,
  BLOB_PARSE_WORKER_DIED,
  populateBlobs,
  storableBlobFacts,
} from '../../src/projection/blob-population.js';
import { describeBlobRefusals } from '../../src/projection/blob-refusals.js';
import { splitProjectionByScope } from '../../src/projection/store.js';
import { ResourceRegistry } from '../../src/resource-registry.js';
import { baseBuilderForRoot, conditionsWithCode } from '../blob-fixture-population.js';
import { deeplyNestedQuote } from '../parse-limit-fixtures.js';
import { countFilesUnder, setupSubdirTestSuite } from '../test-helpers.js';

const suite = setupSubdirTestSuite('vat-parse-limit-lanes-');

/** A stack small enough for the fixture to overflow, a heap large enough that the stack is what it meets. */
const LIMITS: NonNullable<ParsePoolOptions['limits']> = { stackMb: 1, heapMb: 512 };

/** Documents the pools the policy builds were handed, by first line. */
interface Dispatched {
  firstLines: string[];
}

/** A policy whose real, limited pool records what it is asked to parse. */
function recordingPolicy(dispatched: Dispatched): ParsePoolPolicy {
  return {
    limits: LIMITS,
    createPool: (options?: ParsePoolOptions): ParsePool => {
      const real = createParsePool(options);
      return {
        size: real.size,
        parse: async (kind, content, byteLength) => {
          dispatched.firstLines.push(content.split('\n')[0] ?? '');
          return real.parse(kind, content, byteLength);
        },
        parseIntoCache: async (kind, content, byteLength, cacheKey) =>
          real.parseIntoCache(kind, content, byteLength, cacheKey),
        shutdown: async () => real.shutdown(),
      };
    },
  };
}

async function writeCorpus(): Promise<void> {
  await writeFile(safePath.join(suite.tempDir, 'a.md'), '# A\n\n[to c](./c.md)\n', 'utf-8');
  await writeFile(safePath.join(suite.tempDir, 'b.md'), deeplyNestedQuote(), 'utf-8');
  await writeFile(safePath.join(suite.tempDir, 'c.md'), '# C\n\n[to a](./a.md)\n', 'utf-8');
}

/**
 * Admit a.md, b.md and c.md through a registry on a recording pool, and return
 * the findings `validate()` raised with `code`, having checked that b.md alone
 * was refused.
 *
 * @param code - The finding code b.md's refusal is expected under
 * @returns Those findings
 */
async function registryRefusalsOfB(code: string): Promise<ValidationIssue[]> {
  const registry = new ResourceRegistry({
    baseDir: suite.tempDir,
    parseCache: new ParseCache({ enabled: false }),
    parsePool: recordingPolicy({ firstLines: [] }),
  });
  const files = ['a.md', 'b.md', 'c.md'].map((name) => safePath.join(suite.tempDir, name));

  const admitted = await registry.addResources(files);
  const result = await registry.validate();

  expect(admitted.map((resource) => basename(resource.filePath))).toStrictEqual(['a.md', 'c.md']);
  const findings = result.issues.filter((issue) => issue.code === code);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.message).toContain('b.md');
  expect(findings[0]?.severity).toBe('error');
  return findings;
}

describe('a parse stopped at a limit, on the projection lane', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(writeCorpus);

  it('refuses the file naming its limit, keeps every other row, stores nothing, and re-attempts it', async () => {
    const cacheDir = safePath.join(suite.suiteDir, `cache-${String(Date.now())}`);
    const cache = new ParseCache({ cacheDir, enabled: true });
    const first: Dispatched = { firstLines: [] };

    const builder = await baseBuilderForRoot(suite.tempDir);
    const counts = await populateBlobs(builder, { parseCache: cache, parsePool: recordingPolicy(first) });
    const projection = builder.build();

    // Refused, naming the file and the limit.
    const limited = conditionsWithCode(projection, BLOB_PARSE_LIMIT_EXCEEDED);
    expect(limited).toHaveLength(1);
    expect(limited[0]?.message).toContain('b.md');
    expect(limited[0]?.message).toContain('stackMb');
    expect(counts.blobsParseLimited).toBe(1);
    expect(describeBlobRefusals(projection)).toContain('over a parse limit');

    // The other two documents keep every row.
    expect(projection.blobs).toHaveLength(2);
    expect(projection.blobReferences.map((row) => row.rawRef).sort((left, right) => left.localeCompare(right))).toStrictEqual(['./a.md', './c.md']);

    // Nothing about the breach is stored: no condition the shared tier would
    // keep, and a parse-cache entry for the two parsed documents only.
    const { blobs } = splitProjectionByScope(projection);
    expect(conditionsWithCode({ ...projection, ...storableBlobFacts(blobs) }, BLOB_PARSE_LIMIT_EXCEEDED)).toHaveLength(0);
    expect(await countFilesUnder(cacheDir)).toBe(2);

    // The next run hits the cache for the two and parses the breached one again.
    const second: Dispatched = { firstLines: [] };
    const again = await populateBlobs(await baseBuilderForRoot(suite.tempDir), {
      parseCache: cache,
      parsePool: recordingPolicy(second),
    });
    expect(second.firstLines).toHaveLength(1);
    expect(second.firstLines[0]?.startsWith('>>>')).toBe(true);
    expect(again.blobsParseLimited).toBe(1);
  });
});

describe('a parse stopped at a limit, on the registry lane', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(writeCorpus);

  it('records the file as a finding naming its limit, and admits the others', async () => {
    const findings = await registryRefusalsOfB('RESOURCE_PARSE_LIMIT_EXCEEDED');

    expect(findings[0]?.message).toContain('stackMb');
  });
});

/**
 * The built worker, behind a seed that kills its thread with `process.exit(1)`
 * on any document starting `# DIE`. The real worker's listener is attached
 * first; its parse awaits the parser load, so the seed's exit lands before any
 * answer.
 */
async function dyingWorkerEntry(): Promise<string> {
  const realWorker = pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', 'parse-worker.js')).href;
  const entry = safePath.join(suite.suiteDir, `dying-worker-${String(Date.now())}.mjs`);
  await writeFile(
    entry,
    [
      "import { parentPort } from 'node:worker_threads';",
      `await import(${JSON.stringify(realWorker)});`,
      "parentPort.on('message', (request) => { if (request?.content?.startsWith?.('# DIE')) process.exit(1); });",
    ].join('\n'),
    'utf-8',
  );
  return entry;
}

async function writeDyingCorpus(): Promise<void> {
  await writeFile(safePath.join(suite.tempDir, 'a.md'), '# A\n\n[to c](./c.md)\n', 'utf-8');
  await writeFile(safePath.join(suite.tempDir, 'b.md'), '# DIE\n\ntext\n', 'utf-8');
  await writeFile(safePath.join(suite.tempDir, 'c.md'), '# C\n\n[to a](./a.md)\n', 'utf-8');
}

describe('a parse worker that dies holding a job', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);
  beforeEach(writeDyingCorpus);
  beforeEach(async () => {
    __setParseWorkerEntryForTest(await dyingWorkerEntry());
  });
  afterEach(() => {
    __setParseWorkerEntryForTest(null);
  });

  it('on the projection lane: refuses that file, stores nothing, and re-attempts it next run', async () => {
    const cacheDir = safePath.join(suite.suiteDir, `cache-${String(Date.now())}`);
    const cache = new ParseCache({ cacheDir, enabled: true });

    const builder = await baseBuilderForRoot(suite.tempDir);
    const counts = await populateBlobs(builder, { parseCache: cache, parsePool: recordingPolicy({ firstLines: [] }) });
    const projection = builder.build();

    const died = conditionsWithCode(projection, BLOB_PARSE_WORKER_DIED);
    expect(died).toHaveLength(1);
    expect(died[0]?.message).toContain('b.md');
    expect(died[0]?.message).toContain('exited unexpectedly with code 1');
    expect(conditionsWithCode(projection, BLOB_PARSE_FAILED)).toHaveLength(0);
    expect(counts.blobsParseWorkerDied).toBe(1);
    expect(describeBlobRefusals(projection)).toContain('parse worker died');
    expect(projection.blobs).toHaveLength(2);

    const { blobs } = splitProjectionByScope(projection);
    expect(conditionsWithCode({ ...projection, ...storableBlobFacts(blobs) }, BLOB_PARSE_WORKER_DIED)).toHaveLength(0);
    expect(await countFilesUnder(cacheDir)).toBe(2);

    const second: Dispatched = { firstLines: [] };
    const again = await populateBlobs(await baseBuilderForRoot(suite.tempDir), {
      parseCache: cache,
      parsePool: recordingPolicy(second),
    });
    expect(second.firstLines).toStrictEqual(['# DIE']);
    expect(again.blobsParseWorkerDied).toBe(1);
  });

  it('on the registry lane: records a finding naming the file, and admits the others', async () => {
    const findings = await registryRefusalsOfB('RESOURCE_PARSE_WORKER_DIED');

    expect(findings[0]?.message).toContain('exited unexpectedly with code 1');
  });
});
