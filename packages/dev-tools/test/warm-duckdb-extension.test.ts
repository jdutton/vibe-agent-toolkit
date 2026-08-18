import * as fs from 'node:fs';

import { setupSyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { moveCapturedFile } from '../src/warm-duckdb-extension.js';

/* eslint-disable security/detect-non-literal-fs-filename -- test file with dynamic temp paths */

const EXTENSION_FILENAME = 'parquet.duckdb_extension.wasm';
const PAYLOAD = '\0asm-payload';

/** The error `rename` raises when its two paths sit on different volumes. */
function exdev(): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error('EXDEV: cross-device link not permitted, rename');
  error.code = 'EXDEV';
  return error;
}

describe('moveCapturedFile', () => {
  const suite = setupSyncTempDirSuite('warm-duckdb-extension');
  let tempDir: string;
  let source: string;
  let destination: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
    source = safePath.join(tempDir, EXTENSION_FILENAME);
    destination = safePath.join(tempDir, 'dist', EXTENSION_FILENAME);
    fs.mkdirSync(safePath.join(tempDir, 'dist'), { recursive: true });
    fs.writeFileSync(source, PAYLOAD);
  });

  it('moves the file with a plain rename when both paths share a volume', () => {
    moveCapturedFile(source, destination);

    expect(fs.readFileSync(destination, 'utf8')).toBe(PAYLOAD);
    expect(fs.existsSync(source)).toBe(false);
  });

  // The Windows CI runner puts TEMP on C: and the checkout on D:, so the build's
  // only rename crosses a volume boundary. No same-volume machine can provoke
  // that, hence the injected failure.
  it('falls back to copy-then-delete when rename reports EXDEV', () => {
    let attempted = 0;

    moveCapturedFile(source, destination, () => {
      attempted++;
      throw exdev();
    });

    expect(attempted).toBe(1);
    expect(fs.readFileSync(destination, 'utf8')).toBe(PAYLOAD);
    expect(fs.existsSync(source)).toBe(false);
  });

  it('rethrows a rename failure that is not a volume boundary', () => {
    const denied: NodeJS.ErrnoException = new Error('EACCES: permission denied, rename');
    denied.code = 'EACCES';

    expect(() =>
      moveCapturedFile(source, destination, () => {
        throw denied;
      }),
    ).toThrow(/EACCES/);
    // The source must survive a failure, so the scratch tree stays diagnosable.
    expect(fs.existsSync(source)).toBe(true);
    expect(fs.existsSync(destination)).toBe(false);
  });
});
