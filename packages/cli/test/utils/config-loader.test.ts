import * as fs from 'node:fs';
import * as path from 'node:path';

import { setupSyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';

import { loadConfig } from '../../src/utils/config-loader.js';

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
    const configPath = path.join(tempDir, CONFIG_FILENAME);
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
    const configPath = path.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 2\n`; // Invalid version
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    expect(() => loadConfig(tempDir)).toThrow();
  });

  it('should throw on invalid YAML syntax', () => {
    const configPath = path.join(tempDir, CONFIG_FILENAME);
    const configContent = `invalid: yaml: syntax:\n`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    expect(() => loadConfig(tempDir)).toThrow();
  });

  it('should load config with resource collections', () => {
    const configPath = path.join(tempDir, CONFIG_FILENAME);
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
    const configPath = path.join(tempDir, CONFIG_FILENAME);
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
    const configPath = path.join(tempDir, CONFIG_FILENAME);
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
