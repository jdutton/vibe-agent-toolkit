/**
 * Tests for adapter-types utilities
 * Focuses on foundational helper functions used by runtime adapters
 */

import { describe, expect, it } from 'vitest';

import { batchConvert } from '../src/adapter-types.js';

// Helper converter for testing
const uppercaseDoubleConverter = (config: { name: string; value: number }) => ({
  name: config.name.toUpperCase(),
  doubled: config.value * 2,
});

describe('batchConvert', () => {
  it('should convert single config', () => {
    const configs = {
      tool1: { name: 'Tool 1', value: 10 },
    };

    const results = batchConvert(configs, uppercaseDoubleConverter);

    expect(results).toEqual({
      tool1: { name: 'TOOL 1', doubled: 20 },
    });
  });

  it('should convert multiple configs', () => {
    const configs = {
      tool1: { name: 'Tool 1', value: 10 },
      tool2: { name: 'Tool 2', value: 20 },
      tool3: { name: 'Tool 3', value: 30 },
    };

    const results = batchConvert(configs, uppercaseDoubleConverter);

    expect(results).toEqual({
      tool1: { name: 'TOOL 1', doubled: 20 },
      tool2: { name: 'TOOL 2', doubled: 40 },
      tool3: { name: 'TOOL 3', doubled: 60 },
    });
  });

  it('should handle empty configs', () => {
    const configs: Record<string, { name: string; value: number }> = {};

    const results = batchConvert(configs, (config) => ({
      name: config.name,
      value: config.value,
    }));

    expect(results).toEqual({});
  });

  it('should preserve config keys', () => {
    const configs = {
      'my-tool': { value: 1 },
      'another-tool': { value: 2 },
    };

    const results = batchConvert(configs, (config) => config.value * 10);

    expect(Object.keys(results)).toEqual(['my-tool', 'another-tool']);
    expect(results['my-tool']).toBe(10);
    expect(results['another-tool']).toBe(20);
  });

  it('should allow converter to return different types', () => {
    interface Config {
      count: number;
    }

    interface Result {
      total: number;
      message: string;
    }

    const configs: Record<string, Config> = {
      item1: { count: 5 },
      item2: { count: 10 },
    };

    const results = batchConvert<Config, Result>(configs, (config) => ({
      total: config.count,
      message: `Count: ${config.count}`,
    }));

    expect(results.item1).toEqual({ total: 5, message: 'Count: 5' });
    expect(results.item2).toEqual({ total: 10, message: 'Count: 10' });
  });
});
