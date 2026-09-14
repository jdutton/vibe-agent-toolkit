/**
 * `readPackageJsonOrAbsent` — the one reading of an adopter manifest the
 * optional-field lanes share.
 *
 * Three throws used to land in one `catch { return <absent> }` in every lane:
 * no such file, a file that is not JSON, and a file the OS refused. Only the
 * first means "absent". These tests pin that the other two are told apart.
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { readPackageJsonOrAbsent } from '../../src/utils/package-json.js';
import { errno } from '../helpers/refusal-doubles.js';

// The reader names `readFileSync` at import time, so the refusal is injected
// at the module seam.
vi.mock('node:fs', async (importOriginal) =>
  (await import('../helpers/refusal-doubles.js')).spiedModule(importOriginal, ['readFileSync']));

describe('readPackageJsonOrAbsent', () => {
  const suite = setupAsyncTempDirSuite('package-json');
  let manifest: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);
  beforeEach(async () => {
    await suite.beforeEach();
    manifest = safePath.join(suite.getTempDir(), 'package.json');
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the parsed object for a manifest that is there', () => {
    writeFileSync(manifest, '{"name":"x","version":"1.2.3"}\n');

    expect(readPackageJsonOrAbsent(manifest)).toEqual({ name: 'x', version: '1.2.3' });
  });

  it('returns undefined when there is no manifest — the one absence the sentinel means', () => {
    expect(readPackageJsonOrAbsent(manifest)).toBeUndefined();
  });

  it('returns undefined when a path component is a file rather than a directory', () => {
    writeFileSync(safePath.join(suite.getTempDir(), 'notadir'), '');

    expect(readPackageJsonOrAbsent(safePath.join(suite.getTempDir(), 'notadir', 'package.json'))).toBeUndefined();
  });

  it('refuses, by file name, a manifest that is not JSON instead of reading it as absent', () => {
    writeFileSync(manifest, '{ "name": "x", ');

    expect(() => readPackageJsonOrAbsent(manifest)).toThrow(/package\.json is not valid JSON/);
  });

  it('refuses a manifest whose JSON is not an object', () => {
    writeFileSync(manifest, '"just a string"');

    expect(() => readPackageJsonOrAbsent(manifest)).toThrow(/not a JSON object/);
  });

  it('lets a refusal through as itself rather than as an absence', () => {
    writeFileSync(manifest, '{}');
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw errno('EACCES');
    });

    expect(() => readPackageJsonOrAbsent(manifest)).toThrow(expect.objectContaining({ code: 'EACCES' }));
  });
});
