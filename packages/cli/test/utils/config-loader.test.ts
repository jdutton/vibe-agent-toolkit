import * as fs from 'node:fs';

import { setupSyncTempDirSuite, safePath } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import {
  ConfigLoadError,
  loadConfig,
  loadConfigCached,
  resetLoadedConfigCache,
} from '../../src/utils/config-loader.js';

describe('loadConfig', () => {
  const suite = setupSyncTempDirSuite('vat-config');
  let tempDir: string;
  const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
  });

  it('should return undefined when no file exists', () => {
    const result = loadConfig(tempDir);
    expect(result).toBeUndefined();
  });

  it('should load and parse valid config file', () => {
    const configPath = safePath.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 1
resources:
  exclude:
    - "node_modules/**"
  collections:
    docs:
      include:
        - "docs/**/*.md"
`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    const result = loadConfig(tempDir);
    expect(result?.resources?.exclude).toEqual(['node_modules/**']);
    expect(result?.resources?.collections?.docs?.include).toEqual(['docs/**/*.md']);
  });

  it('should throw on invalid config schema', () => {
    const configPath = safePath.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 2\n`; // Invalid version
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    expect(() => loadConfig(tempDir)).toThrow();
  });

  it('should throw on invalid YAML syntax', () => {
    const configPath = safePath.join(tempDir, CONFIG_FILENAME);
    const configContent = `invalid: yaml: syntax:\n`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    expect(() => loadConfig(tempDir)).toThrow();
  });

  it('should load config with resource collections', () => {
    const configPath = safePath.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 1
resources:
  exclude:
    - "**/node_modules/**"
    - "**/dist/**"
  collections:
    project-docs:
      include:
        - "./docs/**/*.md"
        - "./README.md"
    examples:
      include:
        - "./examples/**/*.yaml"
      validation:
        mode: permissive
`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    const result = loadConfig(tempDir);
    expect(result?.resources?.collections).toBeDefined();
    expect(result?.resources?.collections?.['project-docs']).toBeDefined();
    expect(result?.resources?.collections?.['project-docs']?.include).toEqual([
      './docs/**/*.md',
      './README.md',
    ]);
    expect(result?.resources?.collections?.['examples']?.validation?.mode).toBe('permissive');
  });

  it('should load config with claude: section', () => {
    const configPath = safePath.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 1
claude:
  marketplaces:
    my-tools:
      owner:
        name: My Org
      plugins:
        - name: my-tools
          description: My tools plugin
          skills: "*"
`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    const result = loadConfig(tempDir);
    expect(result?.claude).toBeDefined();
    expect(result?.claude?.marketplaces?.['my-tools']).toBeDefined();
    expect(result?.claude?.marketplaces?.['my-tools']?.owner?.name).toBe('My Org');
    expect(result?.claude?.marketplaces?.['my-tools']?.plugins?.[0]?.name).toBe('my-tools');
    expect(result?.claude?.marketplaces?.['my-tools']?.plugins?.[0]?.description).toBe('My tools plugin');
  });

  it('should load complete config with resources and claude sections', () => {
    const configPath = safePath.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 1
resources:
  exclude:
    - "**/node_modules/**"
  collections:
    docs:
      include:
        - "./docs/**/*.md"
claude:
  marketplaces:
    vat-skills:
      owner:
        name: vibe-agent-toolkit contributors
      plugins:
        - name: vat-development-agents
          description: VAT development agents plugin
          skills: "*"
`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    const result = loadConfig(tempDir);
    expect(result?.version).toBe(1);
    expect(result?.resources?.collections?.docs).toBeDefined();
    expect(result?.claude?.marketplaces?.['vat-skills']?.owner?.name).toBe(
      'vibe-agent-toolkit contributors'
    );
  });
});

const CACHED_CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';
const VALID_CONFIG_YAML = 'version: 1\n';

function writeConfigToDir(dir: string, content: string): string {
  const configPath = safePath.join(dir, CACHED_CONFIG_FILENAME);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
  fs.writeFileSync(configPath, content, 'utf-8');
  return configPath;
}

describe('loadConfigCached (Layer 2 cache — spec §8 / §13.5)', () => {
  const suite = setupSyncTempDirSuite('vat-config-cached');
  let tempDir: string;

  beforeAll(suite.beforeAll);
  afterAll(suite.afterAll);

  beforeEach(() => {
    suite.beforeEach();
    tempDir = suite.getTempDir();
    resetLoadedConfigCache();
  });

  it('returns cached config without re-parsing on second call', () => {
    writeConfigToDir(tempDir, VALID_CONFIG_YAML);

    const first = loadConfigCached(tempDir);
    expect(first?.version).toBe(1);

    // Mutate to broken yaml. If the cache hits, we still get the previous
    // parsed result — proving the second call did not re-parse.
    writeConfigToDir(tempDir, ':::: not yaml :::\n');

    const second = loadConfigCached(tempDir);
    expect(second).toBe(first); // same object reference proves cache hit
  });

  it('caches "not found" as undefined (no re-stat per call)', () => {
    // tempDir has no config file. First call returns undefined.
    const first = loadConfigCached(tempDir);
    expect(first).toBeUndefined();

    // Even if we now write a config, the cached undefined wins until reset.
    writeConfigToDir(tempDir, VALID_CONFIG_YAML);

    const second = loadConfigCached(tempDir);
    expect(second).toBeUndefined();
  });

  it('resetLoadedConfigCache() clears the cache', () => {
    // Same setup as above: cache `undefined` then mutate.
    const first = loadConfigCached(tempDir);
    expect(first).toBeUndefined();

    writeConfigToDir(tempDir, VALID_CONFIG_YAML);
    resetLoadedConfigCache();

    const fresh = loadConfigCached(tempDir);
    expect(fresh?.version).toBe(1);
  });

  it('throws ConfigLoadError for a broken config (not silently undefined) and caches the error', () => {
    // A present-but-broken config is a hard error, distinct from an absent one:
    // silently returning undefined here is what regressed `vat skill review` and
    // would let `vat skill test` stage the wrong subject.
    writeConfigToDir(tempDir, 'version: not-a-number\n');

    expect(() => loadConfigCached(tempDir)).toThrow(ConfigLoadError);

    // The error is cached: even fixing the file re-throws the SAME error without
    // re-parsing, until the cache is reset (mirrors the success-cache behavior).
    writeConfigToDir(tempDir, VALID_CONFIG_YAML);
    expect(() => loadConfigCached(tempDir)).toThrow(ConfigLoadError);

    // After a reset, the now-valid file parses cleanly.
    resetLoadedConfigCache();
    expect(loadConfigCached(tempDir)?.version).toBe(1);
  });
});
