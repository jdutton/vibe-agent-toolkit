/**
 * Unit Tests for ONNX model-file publication.
 *
 * These pin how a downloaded model file reaches its cache path, not what it
 * contains. The cache path is shared by every process on the machine and is
 * guarded only by existence, so N concurrent first-users all download and all
 * publish to the same path. Publishing with a plain `writeFile` opens that path
 * with `O_TRUNC` and then writes ~23MB across many syscalls, which leaves a
 * window in which another process reading the same path gets a truncated file.
 * That is what reddened CI as `Failed to load model because protobuf parsing
 * failed` in one test file while a sibling file loading the same path passed.
 *
 * The contract pinned here: a download is published atomically (write a sibling
 * temp, then rename), and a body that does not match its declared length is
 * never published at all.
 */

import type * as FsPromises from 'node:fs/promises';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import { normalizedTmpdir, removeScratchDir, safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureModelFiles } from '../../src/embedding-providers/onnx-utils.js';

const fsCalls = vi.hoisted(() => ({
  writeFilePaths: [] as string[],
  renamePairs: [] as { from: string; to: string }[],
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    writeFile: async (path: unknown, ...rest: unknown[]) => {
      fsCalls.writeFilePaths.push(String(path));
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest);
    },
    rename: async (from: unknown, to: unknown) => {
      fsCalls.renamePairs.push({ from: String(from), to: String(to) });
      return (actual.rename as (...a: unknown[]) => Promise<void>)(from, to);
    },
  };
});

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const MODEL_FILE = 'model_quantized.onnx';

/** A body big enough that publishing it takes more than a single write syscall. */
const MODEL_BODY = Buffer.alloc(256 * 1024, 0x41);
const VOCAB_BODY = Buffer.from('[PAD]\n[UNK]\n[CLS]\n[SEP]\n');

/**
 * Build a `fetch` stub serving the model and vocab URLs.
 *
 * `declaredModelLength` overrides the model response's `content-length` so a
 * caller can simulate a body that arrived short (or an error page served with
 * status 200), which is the other way this cache acquires a file that cannot be
 * parsed.
 */
function stubFetch(declaredModelLength?: number): void {
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    const body = url.endsWith('vocab.txt') ? VOCAB_BODY : MODEL_BODY;
    const declared = url.endsWith('vocab.txt') ? body.byteLength : (declaredModelLength ?? body.byteLength);
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: { 'content-length': String(declared) },
    });
  });
}

describe('ensureModelFiles publication', () => {
  let cacheDir: string;

  beforeEach(async () => {
    fsCalls.writeFilePaths.length = 0;
    fsCalls.renamePairs.length = 0;
    cacheDir = await mkdtemp(safePath.join(normalizedTmpdir(), 'vat-onnx-publish-'));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await removeScratchDir(cacheDir);
  });

  it('publishes the model by renaming a sibling temp, never writing the cache path in place', async () => {
    stubFetch();

    const { modelPath } = await ensureModelFiles(MODEL_ID, cacheDir, true);

    // The destination must never be opened for writing: a concurrent reader of
    // this exact path must see either no file or a complete one.
    expect(fsCalls.writeFilePaths).not.toContain(modelPath);

    const publish = fsCalls.renamePairs.find((pair) => pair.to === modelPath);
    expect(publish).toBeDefined();
    // The temp must be a sibling, or the rename crosses a filesystem (EXDEV).
    expect(dirname(publish?.from ?? '')).toBe(dirname(modelPath));
    // ...and the temp we wrote is the one we renamed.
    expect(fsCalls.writeFilePaths).toContain(publish?.from);

    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp file
    const published = await readFile(modelPath);
    expect(published.byteLength).toBe(MODEL_BODY.byteLength);
  });

  it('refuses to publish a body shorter than its declared length, leaving no cache file', async () => {
    // Server declares the real 23MB-shaped length but the body arrived short —
    // exactly what produces an unparseable ONNX file that then caches forever,
    // because the existence-only guard never re-downloads it.
    stubFetch(MODEL_BODY.byteLength * 2);

    await expect(ensureModelFiles(MODEL_ID, cacheDir, true)).rejects.toThrow(/incomplete|length/i);

    const modelPath = safePath.join(cacheDir, MODEL_ID.replaceAll('/', '_'), MODEL_FILE);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp file
    await expect(stat(modelPath)).rejects.toThrow();
  });

  it('leaves no temp files behind after a successful download', async () => {
    stubFetch();

    const { modelPath, vocabPath } = await ensureModelFiles(MODEL_ID, cacheDir, true);

    const byName = (a: string, b: string): number => a.localeCompare(b);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    const entries = await readdir(dirname(modelPath));
    expect([...entries].sort(byName)).toEqual([MODEL_FILE, basename(vocabPath)].sort(byName));
  });
});
