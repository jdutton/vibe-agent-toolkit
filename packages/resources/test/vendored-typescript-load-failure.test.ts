/**
 * The failure path of `loadVendoredTypeScript`: an import of the vendored file that throws becomes
 * a `ParserUnavailableError` naming the `typescript` kind and carrying the loader's own error, and a
 * rejected load is dropped from the memo so a later call imports again.
 *
 * Driven the way `parser-unavailable-error.test.ts` drives `parser-loader.ts`: the vendored module
 * is mocked with a `default` accessor that throws when read, which is the read the loader performs
 * inside its `try`. The accessor is re-entered on every read, so the attempt count is exact; a
 * factory that throws outright would be replaced by vitest's own mocking error.
 */

import { isAbsolute } from 'node:path';

import { toForwardSlash } from '@vibe-agent-toolkit/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type * as ParseCacheModule from '../src/parse-cache.js';
import type * as VendoredTypeScriptModule from '../src/vendored-typescript.js';

/** The stub's one parse entry point; never called, only its type is checked. */
function stubCreateSourceFile(): undefined {
  return undefined;
}

/** A module with the two members the loader requires: a `createSourceFile` function and a string `version`. */
const STUB = { version: 'stub', createSourceFile: stubCreateSourceFile };

const loader = vi.hoisted(() => ({
  failure: undefined as Error | undefined,
  attempts: 0,
  /** What `default` holds instead of {@link STUB}, when set: a module of the wrong shape. */
  shape: undefined as object | undefined,
}));

vi.mock('../src/vendor/typescript.cjs', () => ({
  get default() {
    loader.attempts += 1;
    if (loader.failure) throw loader.failure;
    return loader.shape ?? STUB;
  },
}));

function enoent(): Error & { code: string } {
  return Object.assign(new Error("ENOENT: no such file, open '/x/dist/vendor/typescript.cjs'"), { code: 'ENOENT' });
}

/**
 * Assert the error's message names the vendored file by its ABSOLUTE path, so a user can see where
 * the file should have been, never the loader-relative specifier.
 *
 * @param thrown - What the load rejected with
 */
function expectNamesVendoredFileByAbsolutePath(thrown: unknown): void {
  const named = /^Cannot load VAT's typescript parser module \((.+?)\): /.exec((thrown as Error).message)?.[1];
  expect(named).toBeDefined();
  expect(isAbsolute(named ?? '')).toBe(true);
  expect(toForwardSlash(named ?? '')).toMatch(/\/vendor\/typescript\.cjs$/);
}

/** A freshly evaluated loader (an empty memo) beside the error class of the same evaluation. */
async function freshLoader(): Promise<typeof VendoredTypeScriptModule & typeof ParseCacheModule> {
  vi.resetModules();
  return { ...(await import('../src/parse-cache.js')), ...(await import('../src/vendored-typescript.js')) };
}

afterEach(() => {
  loader.failure = undefined;
  loader.attempts = 0;
  loader.shape = undefined;
});

describe('loadVendoredTypeScript when the vendored file cannot be imported', () => {
  it('throws ParserUnavailableError for the typescript kind, with the loader error on loaderError', async () => {
    const original = enoent();
    loader.failure = original;
    const mod = await freshLoader();

    const thrown = await mod.loadVendoredTypeScript().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(mod.ParserUnavailableError);
    expect(mod.isParserUnavailable(thrown)).toBe(true);
    expectNamesVendoredFileByAbsolutePath(thrown);
    expect((thrown as InstanceType<typeof mod.ParserUnavailableError>).loaderError).toBe(original);
  });

  it('drops a rejected load from the memo, so a later call imports again', async () => {
    loader.failure = enoent();
    const mod = await freshLoader();

    await expect(mod.loadVendoredTypeScript()).rejects.toBeInstanceOf(mod.ParserUnavailableError);
    expect(loader.attempts).toBe(1);

    loader.failure = undefined;
    await expect(mod.loadVendoredTypeScript()).resolves.toBe(STUB);
    expect(loader.attempts).toBe(2);
  });

  it('memoizes a successful load, so the module is read once (the control for the retry above)', async () => {
    const mod = await freshLoader();

    const first = await mod.loadVendoredTypeScript();
    await expect(mod.loadVendoredTypeScript()).resolves.toBe(first);
    expect(loader.attempts).toBe(1);
  });
});

describe('loadVendoredTypeScript when the vendored file imports but is not TypeScript', () => {
  it.each([
    ['an empty module (a 0-byte or wrong-format file)', {}],
    ['a module with createSourceFile but no version', { createSourceFile: stubCreateSourceFile }],
    ['a module with a version but no createSourceFile', { version: 'stub' }],
  ])('rejects %s with ParserUnavailableError, never handing callers a module that cannot parse', async (_name, shape) => {
    loader.shape = shape;
    const mod = await freshLoader();

    const thrown = await mod.loadVendoredTypeScript().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(mod.ParserUnavailableError);
    expectNamesVendoredFileByAbsolutePath(thrown);
    expect((thrown as InstanceType<typeof mod.ParserUnavailableError>).loaderError).toBeInstanceOf(Error);
  });

  it('drops a wrong-shape load from the memo too, so a repaired file loads on the next call', async () => {
    loader.shape = {};
    const mod = await freshLoader();

    await expect(mod.loadVendoredTypeScript()).rejects.toBeInstanceOf(mod.ParserUnavailableError);
    loader.shape = undefined;
    await expect(mod.loadVendoredTypeScript()).resolves.toBe(STUB);
  });
});
