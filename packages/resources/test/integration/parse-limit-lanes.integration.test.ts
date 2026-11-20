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
import { parseFileCached } from '../../src/parse-dispatcher.js';
import { __setParseWorkerEntryForTest, type ParsePoolOptions } from '../../src/parse-pool.js';
import {
  BLOB_PARSE_FAILED,
  BLOB_PARSE_LIMIT_EXCEEDED,
  BLOB_PARSE_WORKER_DIED,
  storableBlobFacts,
  type BlobPopulationResult,
} from '../../src/projection/blob-population.js';
import { describeBlobRefusals } from '../../src/projection/blob-refusals.js';
import { splitProjectionByScope } from '../../src/projection/store.js';
import { ResourceRegistry } from '../../src/resource-registry.js';
import { baseBuilderForRoot, conditionsWithCode, populateBlobsOnOwnDispatcher } from '../blob-fixture-population.js';
import { deeplyNestedQuote } from '../parse-limit-fixtures.js';
import { countFilesUnder, setupSubdirTestSuite } from '../test-helpers.js';

import { type Dispatched, overDefaultRows, recordingPolicy, registryOverCache } from './recording-parse-policy.js';

const suite = setupSubdirTestSuite('vat-parse-limit-lanes-');

/** A stack small enough for the fixture to overflow, a heap large enough that the stack is what it meets. */
const LIMITS: NonNullable<ParsePoolOptions['limits']> = { stackMb: 1, heapMb: 512 };

/**
 * The next populate of the same tree over the same cache, on a fresh recording pool.
 *
 * @param cache - The cache the first run used
 * @returns What its pool was handed, and what it counted
 */
async function populateAgain(cache: ParseCache): Promise<{ second: Dispatched; again: BlobPopulationResult }> {
  const second: Dispatched = { firstLines: [] };
  const again = await populateBlobsOnOwnDispatcher(await baseBuilderForRoot(suite.tempDir), { cache, policy: recordingPolicy(second, LIMITS) });
  return { second, again };
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
    parsePool: recordingPolicy({ firstLines: [] }, LIMITS),
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
    const counts = await populateBlobsOnOwnDispatcher(builder, { cache, policy: recordingPolicy(first, LIMITS) });
    const projection = builder.build();

    // Refused, naming the file and the limit.
    const limited = conditionsWithCode(projection, BLOB_PARSE_LIMIT_EXCEEDED);
    expect(limited).toHaveLength(1);
    // The blob's condition names no path: twin files share it, and each
    // realization names its own (`notAdmittedRealizations`).
    expect(limited[0]?.message).not.toContain('b.md');
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
    const { second, again } = await populateAgain(cache);
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
 * on any document starting `# DIE`, once it has said the job's parser loaded (as
 * the real worker does before it parses): the document's death. A thread that
 * dies before saying so is never the document's. The real worker's listener is
 * attached first; its parse awaits the parser load, so the seed's exit lands
 * before any answer.
 */
async function dyingWorkerEntry(): Promise<string> {
  const realWorker = pathToFileURL(safePath.resolve(import.meta.dirname, '..', '..', 'dist', 'parse-worker.js')).href;
  const entry = safePath.join(suite.suiteDir, `dying-worker-${String(Date.now())}.mjs`);
  await writeFile(
    entry,
    [
      "import { parentPort } from 'node:worker_threads';",
      `await import(${JSON.stringify(realWorker)});`,
      "parentPort.on('message', (request) => { if (request?.content?.startsWith?.('# DIE')) { parentPort.postMessage({ id: request.id, parserLoaded: request.kind }); process.exit(1); } });",
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
    const counts = await populateBlobsOnOwnDispatcher(builder, { cache, policy: recordingPolicy({ firstLines: [] }, LIMITS) });
    const projection = builder.build();

    const died = conditionsWithCode(projection, BLOB_PARSE_WORKER_DIED);
    expect(died).toHaveLength(1);
    expect(died[0]?.message).not.toContain('b.md');
    expect(died[0]?.message).toContain('exited unexpectedly with code 1');
    expect(conditionsWithCode(projection, BLOB_PARSE_FAILED)).toHaveLength(0);
    expect(counts.blobsParseWorkerDied).toBe(1);
    expect(describeBlobRefusals(projection)).toContain('parse worker died');
    expect(projection.blobs).toHaveLength(2);

    const { blobs } = splitProjectionByScope(projection);
    expect(conditionsWithCode({ ...projection, ...storableBlobFacts(blobs) }, BLOB_PARSE_WORKER_DIED)).toHaveLength(0);
    expect(await countFilesUnder(cacheDir)).toBe(2);

    const { second, again } = await populateAgain(cache);
    expect(second.firstLines).toStrictEqual(['# DIE']);
    expect(again.blobsParseWorkerDied).toBe(1);
  });

  it('on the registry lane: records a finding naming the file, and admits the others', async () => {
    const findings = await registryRefusalsOfB('RESOURCE_PARSE_WORKER_DIED');

    expect(findings[0]?.message).toContain('exited unexpectedly with code 1');
  });
});

describe('a parse with no dispatcher of a document the bounded route refuses', () => {
  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(suite.beforeEach);

  it('is refused under the same limit and files nothing, so a later crawl over the same cache still refuses it', async () => {
    const file = safePath.join(suite.tempDir, 'many-rows.md');
    await writeFile(file, overDefaultRows(), 'utf-8');
    const cacheDir = safePath.join(suite.suiteDir, `cache-no-dispatcher-${String(Date.now())}`);

    // No dispatcher passed: the call still parses in a bounded worker (there is
    // no unbounded lane), so it is refused, and leaves nothing a later run would serve.
    await expect(
      parseFileCached(file, 'markdown', { cache: new ParseCache({ cacheDir, enabled: true }) }),
    ).rejects.toMatchObject({ code: 'PARSE_LIMIT_EXCEEDED' });
    expect(await countFilesUnder(cacheDir)).toBe(0);

    const registry = registryOverCache(suite.tempDir, cacheDir, recordingPolicy({ firstLines: [] }, {}));
    expect(await registry.addResources([file])).toHaveLength(0);
    expect(registry.getParseRefusedResources().map((entry) => entry.reason)).toStrictEqual([
      expect.stringContaining('outputRows'),
    ]);
  });
});
