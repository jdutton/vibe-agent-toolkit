/**
 * The CACHED config lane (`loadConfigCached`, which `resources check` and
 * `skill review` use) publishes the refusal the failure IS, not the one its
 * throw site suggests: an unreadable config is `INPUT_UNREADABLE`, a defect
 * inside the loader is `INTERNAL_ERROR` — never both `CONFIG_INVALID`.
 */

import type * as Resources from '@vibe-agent-toolkit/resources';
import { normalizedTmpdir, resolveFromImportMeta } from '@vibe-agent-toolkit/utils/fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { refusalCodeOf } from '../../src/utils/command-refusal.js';
import { ConfigLoadError, loadConfigCached, resetLoadedConfigCache } from '../../src/utils/config-loader.js';

/** A defect inside the loader: the schema pass throws a TypeError when this marker is set. */
const DEFECT_MARKER = 'config-loader-refusal-defect';

vi.mock('@vibe-agent-toolkit/resources', async (importOriginal) => {
  const original = await importOriginal<typeof Resources>();
  return {
    ...original,
    parseConfigAllowingUnknownKeys: (...args: Parameters<typeof original.parseConfigAllowingUnknownKeys>) => {
      if (process.env['VAT_TEST_CONFIG_DEFECT'] === DEFECT_MARKER) throw new TypeError('loader defect');
      return original.parseConfigAllowingUnknownKeys(...args);
    },
  };
});

/** What `fn` threw. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

beforeEach(() => {
  resetLoadedConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetLoadedConfigCache();
});

describe('loadConfigCached — the refusal a failure becomes', () => {
  it('an unreadable config is INPUT_UNREADABLE, still a ConfigLoadError for the callers that tolerate one', () => {
    // A directory where the file should be: `existsSync` says yes and the read
    // is refused (EISDIR) — the same class of OS refusal as EACCES, and it holds
    // under root and on Windows, where `chmod 000` does not.
    vi.stubEnv('VAT_TEST_CONFIG', normalizedTmpdir());

    const error = thrownBy(() => loadConfigCached('/project'));

    expect(error).toBeInstanceOf(ConfigLoadError);
    expect(refusalCodeOf(error)).toBe('INPUT_UNREADABLE');
  });

  it('a TypeError inside the loader is INTERNAL_ERROR, rethrown unchanged — not relabelled a broken config', () => {
    vi.stubEnv('VAT_TEST_CONFIG', resolveFromImportMeta(import.meta.url, '..', '..', '..', '..', 'vibe-agent-toolkit.config.yaml'));
    vi.stubEnv('VAT_TEST_CONFIG_DEFECT', DEFECT_MARKER);

    const error = thrownBy(() => loadConfigCached('/project'));

    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(ConfigLoadError);
    expect(refusalCodeOf(error)).toBe('INTERNAL_ERROR');
    // Cached: the second call rethrows the same defect without re-running the loader.
    expect(thrownBy(() => loadConfigCached('/project'))).toBe(error);
  });
});
