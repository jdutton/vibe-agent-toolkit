import * as fs from 'node:fs';

import { setupSyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { cleanBuildArtifacts, parseArgs } from '../src/tsc-clean-build.js';

/* eslint-disable security/detect-non-literal-fs-filename -- test file with dynamic temp paths */

describe('cleanBuildArtifacts', () => {
  const suite = setupSyncTempDirSuite('tsc-clean-build');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('removes an existing dist directory, including orphaned output for a deleted source', () => {
    const distDir = safePath.join(tempDir, 'dist');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(safePath.join(distDir, 'index.js'), 'export {};');
    fs.writeFileSync(safePath.join(distDir, 'orphaned-from-deleted-source.js'), 'export {};');

    cleanBuildArtifacts(tempDir);

    expect(fs.existsSync(distDir)).toBe(false);
  });

  it('removes tsconfig.tsbuildinfo files in the package root', () => {
    fs.writeFileSync(safePath.join(tempDir, 'tsconfig.tsbuildinfo'), '{}');

    cleanBuildArtifacts(tempDir);

    expect(fs.existsSync(safePath.join(tempDir, 'tsconfig.tsbuildinfo'))).toBe(false);
  });

  it('is a no-op when neither dist nor tsbuildinfo files exist', () => {
    expect(() => cleanBuildArtifacts(tempDir)).not.toThrow();
    expect(fs.existsSync(safePath.join(tempDir, 'dist'))).toBe(false);
  });

  it('does not touch source files outside dist', () => {
    fs.writeFileSync(safePath.join(tempDir, 'src-marker.ts'), 'export const x = 1;');

    cleanBuildArtifacts(tempDir);

    expect(fs.existsSync(safePath.join(tempDir, 'src-marker.ts'))).toBe(true);
  });
});

describe('parseArgs', () => {
  it('defaults to the tsc compiler with no flags', () => {
    expect(parseArgs([])).toEqual({ compiler: 'tsc', compilerArgs: [] });
  });

  it('passes through compiler args unchanged', () => {
    expect(parseArgs(['--build'])).toEqual({ compiler: 'tsc', compilerArgs: ['--build'] });
  });

  it('extracts a --compiler= flag and strips it from the passed-through args', () => {
    expect(parseArgs(['--compiler=tspc', '--build'])).toEqual({
      compiler: 'tspc',
      compilerArgs: ['--build'],
    });
  });
});
