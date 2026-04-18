import { describe, it, expect } from 'vitest';

import {
  PATTERN_REGISTRY,
  getPatternDefinition,
  assertPatternRegistered,
} from '../../src/evidence/pattern-registry.js';

describe('PATTERN_REGISTRY', () => {
  it('returns a pattern definition by ID', () => {
    const def = getPatternDefinition('FENCED_SHELL_BLOCK');
    expect(def).toBeDefined();
    expect(def?.source).toBe('code');
    expect(def?.confidence).toBe('high');
  });

  it('returns undefined for unknown IDs', () => {
    expect(getPatternDefinition('NOT_A_PATTERN')).toBeUndefined();
  });

  it('assertPatternRegistered throws for unknown IDs', () => {
    expect(() => assertPatternRegistered('NOT_A_PATTERN')).toThrow(/Unregistered pattern ID/);
  });

  it('every registry entry has matching patternId field', () => {
    for (const [key, def] of Object.entries(PATTERN_REGISTRY)) {
      expect(def.patternId).toBe(key);
    }
  });

  it('every registry entry declares source', () => {
    for (const def of Object.values(PATTERN_REGISTRY)) {
      expect(['code', 'ai']).toContain(def.source);
    }
  });

  it('every registry entry declares confidence', () => {
    for (const def of Object.values(PATTERN_REGISTRY)) {
      expect(['high', 'medium', 'low']).toContain(def.confidence);
    }
  });
});
