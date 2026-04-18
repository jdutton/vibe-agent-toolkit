import { describe, it, expect } from 'vitest';

import { resolveEffectiveTargets } from '../src/marketplace-defaults.js';

const CHAT = 'claude-chat' as const;
const COWORK = 'claude-cowork' as const;
const CODE = 'claude-code' as const;

describe('resolveEffectiveTargets', () => {
  it('plugin targets override all', () => {
    expect(resolveEffectiveTargets({
      configTargets: [CHAT],
      pluginTargets: [CODE],
      marketplaceTargets: [COWORK],
    })).toEqual([CODE]);
  });

  it('marketplace overrides config when plugin absent', () => {
    expect(resolveEffectiveTargets({
      configTargets: [CHAT],
      pluginTargets: undefined,
      marketplaceTargets: [COWORK],
    })).toEqual([COWORK]);
  });

  it('config used when plugin and marketplace absent', () => {
    expect(resolveEffectiveTargets({
      configTargets: [CODE],
      pluginTargets: undefined,
      marketplaceTargets: undefined,
    })).toEqual([CODE]);
  });

  it('all absent returns undefined (undeclared)', () => {
    expect(resolveEffectiveTargets({
      configTargets: undefined,
      pluginTargets: undefined,
      marketplaceTargets: undefined,
    })).toBeUndefined();
  });

  it('explicit empty plugin targets override marketplace', () => {
    expect(resolveEffectiveTargets({
      configTargets: [CODE],
      pluginTargets: [],
      marketplaceTargets: [COWORK],
    })).toEqual([]);
  });
});
