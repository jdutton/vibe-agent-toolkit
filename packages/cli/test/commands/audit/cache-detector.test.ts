import type { ResourceMetadata } from '@vibe-agent-toolkit/resources';
import { describe, expect, it } from 'vitest';

import { detectCacheStaleness } from '../../../src/commands/audit/cache-detector.js';

// Constants for test data
const COMMON_CHECKSUM = 'abc123';
const COMMON_DATE = new Date('2024-01-01');

describe('detectCacheStaleness', () => {
  it('should detect when cache is fresh (checksums match)', () => {
    const installed: ResourceMetadata[] = [
      {
        id: 'skill-1',
        filePath: '/plugins/marketplace1/plugin1/skills/skill1/SKILL.md',
        checksum: COMMON_CHECKSUM,
        links: [],
        headings: [],
        sizeBytes: 1000,
        estimatedTokenCount: 250,
        modifiedAt: COMMON_DATE,
      },
    ];

    const cached: ResourceMetadata[] = [
      {
        id: 'skill-1-cached',
        filePath: '/cache/marketplace1/plugin1/skills/skill1/SKILL.md',
        checksum: COMMON_CHECKSUM, // Same checksum
        links: [],
        headings: [],
        sizeBytes: 1000,
        estimatedTokenCount: 250,
        modifiedAt: COMMON_DATE,
      },
    ];

    const result = detectCacheStaleness(installed, cached);

    expect(result).toEqual({
      fresh: [
        {
          installed: installed[0],
          cached: cached[0],
        },
      ],
      stale: [],
      cacheOnly: [],
      installedOnly: [],
    });
  });

  it('should detect when cache is stale (checksums differ)', () => {
    const installed: ResourceMetadata[] = [
      {
        id: 'skill-1',
        filePath: '/plugins/marketplace1/plugin1/skills/skill1/SKILL.md',
        checksum: COMMON_CHECKSUM,
        links: [],
        headings: [],
        sizeBytes: 1000,
        estimatedTokenCount: 250,
        modifiedAt: new Date('2024-01-02'),
      },
    ];

    const cached: ResourceMetadata[] = [
      {
        id: 'skill-1-cached',
        filePath: '/cache/marketplace1/plugin1/skills/skill1/SKILL.md',
        checksum: 'old456', // Different checksum
        links: [],
        headings: [],
        sizeBytes: 900,
        estimatedTokenCount: 225,
        modifiedAt: new Date('2024-01-01'),
      },
    ];

    const result = detectCacheStaleness(installed, cached);

    expect(result).toEqual({
      fresh: [],
      stale: [
        {
          installed: installed[0],
          cached: cached[0],
        },
      ],
      cacheOnly: [],
      installedOnly: [],
    });
  });

  it('should detect cache-only files (not in installed)', () => {
    const installed: ResourceMetadata[] = [];

    const cached: ResourceMetadata[] = [
      {
        id: 'skill-orphan',
        filePath: '/cache/old-plugin/SKILL.md',
        checksum: 'xyz789',
        links: [],
        headings: [],
        sizeBytes: 500,
        estimatedTokenCount: 125,
        modifiedAt: new Date('2023-12-01'),
      },
    ];

    const result = detectCacheStaleness(installed, cached);

    expect(result).toEqual({
      fresh: [],
      stale: [],
      cacheOnly: [cached[0]],
      installedOnly: [],
    });
  });

  it('should detect installed-only files (not in cache)', () => {
    const installed: ResourceMetadata[] = [
      {
        id: 'skill-new',
        filePath: '/plugins/new-plugin/SKILL.md',
        checksum: 'new999',
        links: [],
        headings: [],
        sizeBytes: 2000,
        estimatedTokenCount: 500,
        modifiedAt: new Date('2024-02-01'),
      },
    ];

    const cached: ResourceMetadata[] = [];

    const result = detectCacheStaleness(installed, cached);

    expect(result).toEqual({
      fresh: [],
      stale: [],
      cacheOnly: [],
      installedOnly: [installed[0]],
    });
  });

  it('should handle empty inputs', () => {
    const result = detectCacheStaleness([], []);

    expect(result).toEqual({
      fresh: [],
      stale: [],
      cacheOnly: [],
      installedOnly: [],
    });
  });
});
