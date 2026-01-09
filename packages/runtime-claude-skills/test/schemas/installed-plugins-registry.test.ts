import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { InstalledPluginsRegistrySchema } from '../../src/schemas/installed-plugins-registry.js';

function loadRegistryFixture(name: string): unknown {
  const fixturePath = resolve(__dirname, '../fixtures/registries', name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test helper loading fixtures from known directory
  return JSON.parse(readFileSync(fixturePath, 'utf-8'));
}

const VALID_INSTALLATION_ENTRY = {
  scope: 'user',
  installPath: '/path',
  version: '1.0.0',
  installedAt: '2024-01-01T00:00:00Z',
  lastUpdated: '2024-01-01T00:00:00Z',
  isLocal: false,
};

describe('InstalledPluginsRegistrySchema', () => {
  it('should validate known-good installed_plugins.json', () => {
    const knownGood = loadRegistryFixture('installed_plugins.json');
    const result = InstalledPluginsRegistrySchema.safeParse(knownGood);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(2);
      expect(typeof result.data.plugins).toBe('object');
    }
  });

  describe('validation errors', () => {
    it('should reject registry with missing version field', () => {
      const invalid = {
        plugins: {},
      };

      const result = InstalledPluginsRegistrySchema.safeParse(invalid);
      expect(result.success).toBe(false);
      if (!result.success) {
        const versionError = result.error.issues.find(i => i.path[0] === 'version');
        expect(versionError).toBeDefined();
      }
    });

    it('should reject registry with invalid version (not 2)', () => {
      const invalid = {
        version: 1,
        plugins: {},
      };

      const result = InstalledPluginsRegistrySchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject invalid plugin key format (no @)', () => {
      const invalid = {
        version: 2,
        plugins: {
          'invalid-key-no-at': [VALID_INSTALLATION_ENTRY],
        },
      };

      const result = InstalledPluginsRegistrySchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject empty installation array', () => {
      const invalid = {
        version: 2,
        plugins: {
          'plugin@marketplace': [],
        },
      };

      const result = InstalledPluginsRegistrySchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject installation with invalid scope', () => {
      const invalid = {
        version: 2,
        plugins: {
          'plugin@marketplace': [{
            ...VALID_INSTALLATION_ENTRY,
            scope: 'global',  // Invalid: must be 'user' or 'system'
          }],
        },
      };

      const result = InstalledPluginsRegistrySchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject installation with missing required field', () => {
      const entryWithoutIsLocal = {
        scope: VALID_INSTALLATION_ENTRY.scope,
        installPath: VALID_INSTALLATION_ENTRY.installPath,
        version: VALID_INSTALLATION_ENTRY.version,
        installedAt: VALID_INSTALLATION_ENTRY.installedAt,
        lastUpdated: VALID_INSTALLATION_ENTRY.lastUpdated,
      };
      const invalid = {
        version: 2,
        plugins: {
          'plugin@marketplace': [entryWithoutIsLocal],
        },
      };

      const result = InstalledPluginsRegistrySchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject installation with invalid datetime format', () => {
      const invalid = {
        version: 2,
        plugins: {
          'plugin@marketplace': [{
            ...VALID_INSTALLATION_ENTRY,
            installedAt: 'not-a-datetime',
          }],
        },
      };

      const result = InstalledPluginsRegistrySchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });
  });
});
