/**
 * The shared vitest setup (`vitest.setup.js`) never leaves a test pointed at a real Claude
 * configuration. `vat` reads `CLAUDE_CONFIG_DIR` before `HOME`, so a developer's own value aims every
 * install, uninstall and clear a test runs without its own stub at their real `~/.claude` — and an
 * UNSET one falls back to `$HOME/.claude`, which is just as real. Both happened: a reproduction and
 * then a test each installed a fixture plugin into a live Claude config.
 */

import { homedir } from 'node:os';

import { vatCacheRoot } from '@vibe-agent-toolkit/resources';
import { canonicalPath, normalizedTmpdir, relativeEscapesRoot, safePath, VAT_CACHE_DIR_ENV } from '@vibe-agent-toolkit/utils';
import { describe, expect, it, vi } from 'vitest';

// Both are the test process's own environment paths: each is its own edge.
const isUnder = (root: string, path: string): boolean => !relativeEscapesRoot(safePath.relative(canonicalPath(root, root), canonicalPath(path, path)));

describe('vitest.setup.js — the Claude configuration a test sees by default', () => {
  const configured = process.env['CLAUDE_CONFIG_DIR'] ?? '';

  it('is a scratch directory under the temp directory, never unset (unset falls back to $HOME/.claude)', () => {
    expect(configured).not.toBe('');
    expect(isUnder(normalizedTmpdir(), configured), configured).toBe(true);
  });

  it('is not under the real home directory\'s Claude configuration', () => {
    expect(isUnder(safePath.join(homedir(), '.claude'), configured), configured).toBe(false);
  });
});

describe('vitest.setup.js — the VAT cache a test sees by default', () => {
  const configured = process.env[VAT_CACHE_DIR_ENV] ?? '';

  it('is this test file\'s own directory under the temp directory, never the machine-wide default', () => {
    expect(configured).not.toBe('');
    expect(isUnder(normalizedTmpdir(), configured), configured).toBe(true);
    expect(vatCacheRoot()).toBe(safePath.resolve(configured));
    expect(vatCacheRoot()).not.toBe(safePath.join(normalizedTmpdir(), '.vat-cache'));
  });

  it('is refused, not silently shared, when a test unsets it without moving the temp directory', () => {
    vi.stubEnv(VAT_CACHE_DIR_ENV, undefined);
    try {
      expect(() => vatCacheRoot()).toThrow(/shared by every process on this machine/);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
