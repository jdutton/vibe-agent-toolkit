import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import {
  detectInstalledPluginsRegistryDrift,
  InstalledPluginsRegistrySchema,
} from '../../src/schemas/installed-plugins-registry.js';

function loadRegistryFixture(name: string): unknown {
  const fixturePath = safePath.resolve(__dirname, '../fixtures/registries', name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test helper loading fixtures from known directory
  return JSON.parse(readFileSync(fixturePath, 'utf-8'));
}

const TIMESTAMP = '2024-01-01T00:00:00Z';

const VALID_INSTALLATION_ENTRY = {
  scope: 'user',
  installPath: '/path',
  version: '1.0.0',
  installedAt: TIMESTAMP,
  lastUpdated: TIMESTAMP,
  isLocal: false,
};

const PLUGIN_KEY = 'plugin@marketplace';

function registryWithEntry(entry: Record<string, unknown>): unknown {
  return { version: 2, plugins: { [PLUGIN_KEY]: [entry] } };
}

// Claude Code's registry is external data VAT does not control. Postel's Law
// (CLAUDE.md): read it liberally. These cases are all shapes the *current*
// Claude Code actually writes — every one of them used to be a hard error.
describe('InstalledPluginsRegistrySchema — liberal reading of external data', () => {
  it('absorbs an unknown top-level field instead of erroring', () => {
    const result = InstalledPluginsRegistrySchema.safeParse({
      version: 2,
      plugins: {},
      installSource: 'some-future-field',
    });

    expect(result.success).toBe(true);
  });

  it('absorbs an unknown installation field instead of erroring', () => {
    const result = InstalledPluginsRegistrySchema.safeParse(
      registryWithEntry({ ...VALID_INSTALLATION_ENTRY, futureField: 'whatever' }),
    );

    expect(result.success).toBe(true);
  });

  it("accepts scope 'project' together with projectPath", () => {
    const result = InstalledPluginsRegistrySchema.safeParse(
      registryWithEntry({
        scope: 'project',
        projectPath: '/Users/someone/Workspaces/some-project',
        installPath: '/path',
        version: '1.0.0',
        installedAt: TIMESTAMP,
        lastUpdated: TIMESTAMP,
      }),
    );

    expect(result.success).toBe(true);
  });

  it("accepts scope 'local'", () => {
    const result = InstalledPluginsRegistrySchema.safeParse(
      registryWithEntry({ ...VALID_INSTALLATION_ENTRY, scope: 'local' }),
    );

    expect(result.success).toBe(true);
  });

  it('accepts an installation entry with no isLocal field', () => {
    const result = InstalledPluginsRegistrySchema.safeParse(
      registryWithEntry({
        scope: 'user',
        installPath: '/path',
        version: '1.0.0',
        installedAt: TIMESTAMP,
        lastUpdated: TIMESTAMP,
      }),
    );

    expect(result.success).toBe(true);
  });
});

// Passthrough alone would trade false errors for total blindness to real schema
// evolution. Drift detection is what keeps the liberality visible.
describe('detectInstalledPluginsRegistryDrift', () => {
  it('reports nothing for a registry made only of recognized shapes', () => {
    expect(detectInstalledPluginsRegistryDrift(loadRegistryFixture('installed_plugins.json'))).toEqual([]);
  });

  it("reports nothing for the shapes current Claude Code writes ('project' + projectPath, no isLocal)", () => {
    const drift = detectInstalledPluginsRegistryDrift(
      registryWithEntry({
        scope: 'project',
        projectPath: '/Users/someone/Workspaces/some-project',
        installPath: '/path',
        version: '1.0.0',
        installedAt: TIMESTAMP,
        lastUpdated: TIMESTAMP,
      }),
    );

    expect(drift).toEqual([]);
  });

  it('reports an unknown top-level field', () => {
    const drift = detectInstalledPluginsRegistryDrift({
      version: 2,
      plugins: {},
      installSource: 'some-future-field',
    });

    expect(drift).toHaveLength(1);
    expect(drift[0]?.field).toBe('installSource');
    expect(drift[0]?.message).toContain('installSource');
  });

  it('reports an unknown installation field, pointing at the entry that carries it', () => {
    const drift = detectInstalledPluginsRegistryDrift(
      registryWithEntry({ ...VALID_INSTALLATION_ENTRY, futureField: 'whatever' }),
    );

    expect(drift).toHaveLength(1);
    expect(drift[0]?.field).toBe(`plugins.${PLUGIN_KEY}.0.futureField`);
  });

  it('reports an unrecognized scope value', () => {
    const drift = detectInstalledPluginsRegistryDrift(
      registryWithEntry({ ...VALID_INSTALLATION_ENTRY, scope: 'enterprise' }),
    );

    expect(drift).toHaveLength(1);
    expect(drift[0]?.field).toBe(`plugins.${PLUGIN_KEY}.0.scope`);
    expect(drift[0]?.message).toContain('enterprise');
  });

  it('reports one observation per distinct unknown, not one per entry', () => {
    const drift = detectInstalledPluginsRegistryDrift({
      version: 2,
      plugins: {
        'a@m': [{ ...VALID_INSTALLATION_ENTRY, futureField: 1 }],
        'b@m': [{ ...VALID_INSTALLATION_ENTRY, futureField: 2 }],
        'c@m': [{ ...VALID_INSTALLATION_ENTRY, futureField: 3 }],
      },
    });

    expect(drift).toHaveLength(1);
  });

  it('reports nothing for a non-object input', () => {
    expect(detectInstalledPluginsRegistryDrift('not a registry')).toEqual([]);
  });
});

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
          [PLUGIN_KEY]: [],
        },
      };

      const result = InstalledPluginsRegistrySchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject installation with a non-string scope', () => {
      const invalid = {
        version: 2,
        plugins: {
          [PLUGIN_KEY]: [{
            ...VALID_INSTALLATION_ENTRY,
            scope: 42,
          }],
        },
      };

      const result = InstalledPluginsRegistrySchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject installation with missing required field', () => {
      const entryWithoutInstallPath = {
        scope: VALID_INSTALLATION_ENTRY.scope,
        version: VALID_INSTALLATION_ENTRY.version,
        installedAt: VALID_INSTALLATION_ENTRY.installedAt,
        lastUpdated: VALID_INSTALLATION_ENTRY.lastUpdated,
      };
      const invalid = {
        version: 2,
        plugins: {
          [PLUGIN_KEY]: [entryWithoutInstallPath],
        },
      };

      const result = InstalledPluginsRegistrySchema.safeParse(invalid);
      expect(result.success).toBe(false);
    });

    it('should reject installation with invalid datetime format', () => {
      const invalid = {
        version: 2,
        plugins: {
          [PLUGIN_KEY]: [{
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
