import { describe, it, expect } from 'vitest';

import { RUNTIME_PROFILES, getRuntimeProfile } from '../src/runtime-profiles.js';
import { ALL_TARGETS } from '../src/types.js';

describe('RUNTIME_PROFILES', () => {
  it('defines a profile for every target', () => {
    for (const target of ALL_TARGETS) {
      expect(RUNTIME_PROFILES[target]).toBeDefined();
    }
  });

  it('claude-chat has no shell', () => {
    expect(RUNTIME_PROFILES['claude-chat'].localShell).toBe('no');
  });

  it('claude-cowork has shell and restricted network', () => {
    const profile = RUNTIME_PROFILES['claude-cowork'];
    expect(profile.localShell).toBe('yes');
    expect(profile.network).toBe('restricted');
  });

  it('claude-code has shell and full network', () => {
    const profile = RUNTIME_PROFILES['claude-code'];
    expect(profile.localShell).toBe('yes');
    expect(profile.network).toBe('full');
  });

  it('claude-cowork guarantees python3 and node', () => {
    const bins = RUNTIME_PROFILES['claude-cowork'].preinstalledBinaries;
    expect(bins.has('python3')).toBe(true);
    expect(bins.has('node')).toBe(true);
  });

  it('getRuntimeProfile returns the same as direct lookup', () => {
    expect(getRuntimeProfile('claude-code')).toBe(RUNTIME_PROFILES['claude-code']);
  });
});
