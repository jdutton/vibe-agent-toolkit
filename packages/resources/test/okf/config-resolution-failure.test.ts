/**
 * `resolveBundleRoot` degrades a bundle root Node's module resolver REFUSES to
 * plain path resolution, so the root becomes one bundle's own finding. The
 * `no-blind-catch` split: only the resolver's own answers (`MODULE_NOT_FOUND`,
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`, …) may degrade. A throw from anywhere else
 * inside `resolveAssetReference` is a bug, and swallowing it would mint a root
 * the adopter never wrote and then report THAT as unreadable.
 *
 * Its own file because the mock is module-wide.
 */

import type * as VatUtils from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

import { okfBundleRuns } from '../../src/okf/config.js';

type ResolveBehaviour = 'real' | { readonly throws: unknown };

const resolver = vi.hoisted(() => ({ behaviour: 'real' as ResolveBehaviour }));

vi.mock('@vibe-agent-toolkit/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof VatUtils>();
  const resolveAssetReference: typeof actual.resolveAssetReference = (specifier, baseDir) => {
    if (resolver.behaviour !== 'real') throw resolver.behaviour.throws;
    return actual.resolveAssetReference(specifier, baseDir);
  };
  return { ...actual, resolveAssetReference };
});

const CONFIG_DIR = '/proj';
const SCOPED_ROOT = '@vat-okf-fixture/not-installed/bundle';

function runsFor(): ReturnType<typeof okfBundleRuns> {
  return okfBundleRuns({ bundles: { scoped: { root: SCOPED_ROOT } } }, CONFIG_DIR);
}

/** Run the bundle table with `resolveAssetReference` throwing `thrown`, restoring afterwards. */
function withResolverThrowing<T>(thrown: unknown, body: () => T): T {
  resolver.behaviour = { throws: thrown };
  try {
    return body();
  } finally {
    resolver.behaviour = 'real';
  }
}

/** A throw shaped the way `resolveAssetReference` wraps the module resolver's. */
function wrappedResolverRefusal(code: string): Error {
  const cause = Object.assign(new Error(`resolver refused: ${code}`), { code });
  return new Error('Failed to resolve asset reference', { cause });
}

describe('resolveBundleRoot — what may degrade to a path', () => {
  it.each([
    ['a package that is not installed', 'MODULE_NOT_FOUND'],
    ['an exports-map exclusion', 'ERR_PACKAGE_PATH_NOT_EXPORTED'],
  ])("degrades the resolver's own refusal for %s", (_case, code) => {
    const root = withResolverThrowing(wrappedResolverRefusal(code), () => runsFor()[0]?.root);

    expect(root).toBe(`${CONFIG_DIR}/${SCOPED_ROOT}`);
  });

  it('propagates a throw that is not the resolver refusing', () => {
    const bug = new TypeError('simulated defect inside resolveAssetReference');

    expect(() => withResolverThrowing(bug, runsFor)).toThrow(bug);
  });
});
