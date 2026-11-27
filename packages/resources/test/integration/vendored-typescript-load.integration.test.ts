/**
 * The vendored TypeScript loads where it ships: through the BUILT loader, in plain `node`, on a main
 * thread and in a worker, and is the exact version `resources` declares.
 *
 * The positive control is red by construction: the same bytes under a `.js` name in a
 * `"type": "module"` package import as an EMPTY module (no error, no `version`), which is why the
 * copy is named `.cjs`. A regression to the `.js` name is therefore a failure this file can see,
 * not a silent empty namespace.
 */

import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import { normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { declaredTypeScriptVersion } from '../helpers/declared-typescript-version.js';

import { expectProbeLoadsDeclaredVersion, importedShape } from './vendored-typescript-probe.js';

/** The `resources` package directory. */
const PACKAGE_DIR = safePath.resolve(import.meta.dirname, '../..');

/** The built loader every shipped caller reaches the vendored file through. */
const BUILT_LOADER = safePath.join(PACKAGE_DIR, 'dist/vendored-typescript.js');

/** The built copy of the vendored file. */
const BUILT_COPY = safePath.join(PACKAGE_DIR, 'dist/vendor/typescript.cjs');

describe('the vendored TypeScript, loaded from the build by plain node', () => {
  it('loads through the built loader on a main thread, at the declared version, and parses', () => {
    expectProbeLoadsDeclaredVersion(BUILT_LOADER, 'main');
  });

  it('loads through the built loader inside a worker_threads worker, at the declared version, and parses', () => {
    expectProbeLoadsDeclaredVersion(BUILT_LOADER, 'worker');
  });
});

describe('positive control: the file\'s extension decides whether it loads at all', () => {
  let moduleDir = '';

  beforeAll(() => {
    moduleDir = mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-vendored-ts-ext-'));
    writeFileSync(safePath.join(moduleDir, 'package.json'), '{"type":"module"}\n');
    copyFileSync(BUILT_COPY, safePath.join(moduleDir, 'typescript.js'));
    copyFileSync(BUILT_COPY, safePath.join(moduleDir, 'typescript.cjs'));
  });

  afterAll(() => {
    rmSync(moduleDir, { recursive: true, force: true });
  });

  it('the same bytes named .js in a "type": "module" package import as an empty module', () => {
    expect(importedShape(safePath.join(moduleDir, 'typescript.js'))).toEqual({ keys: [], defaultVersion: null, parses: false });
  });

  it('named .cjs, they load in full', () => {
    expect(importedShape(safePath.join(moduleDir, 'typescript.cjs'))).toMatchObject({
      defaultVersion: declaredTypeScriptVersion(),
      parses: true,
    });
  });
});
