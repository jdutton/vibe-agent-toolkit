/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
// Test file - all file operations are in temp directories, duplicated strings acceptable
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findConfigFile, loadConfig, parseConfigFile } from '../src/config-parser.js';
import { ProjectConfigSchema } from '../src/schemas/project-config.js';

import { setupTempDirTestSuite } from './test-helpers.js';

// Test constants
const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

describe('parseConfigFile', () => {
  const suite = setupTempDirTestSuite('config-parse-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should parse valid config file', async () => {
    const configPath = join(suite.tempDir, CONFIG_FILENAME);
    const content = `
version: 1
resources:
  collections:
    rag-kb:
      include: ['docs']
`;
    await writeFile(configPath, content);

    const config = await parseConfigFile(configPath);

    expect(config.version).toBe(1);
    expect(config.resources?.collections).toHaveProperty('rag-kb');
    expect(config.resources?.collections['rag-kb']?.include).toEqual(['docs']);
  });

  it('should parse config with validation settings', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 1
resources:
  collections:
    skills:
      include: ['**/SKILL.md']
      validation:
        frontmatterSchema: 'schemas/skill.schema.json'
        mode: strict
        checkUrlLinks: true
`;
    await writeFile(configPath, content);

    const config = await parseConfigFile(configPath);

    const skillsCollection = config.resources?.collections['skills'];
    expect(skillsCollection?.validation?.frontmatterSchema).toBe('schemas/skill.schema.json');
    expect(skillsCollection?.validation?.mode).toBe('strict');
    expect(skillsCollection?.validation?.checkUrlLinks).toBe(true);
  });

  it('should parse config with exclude patterns', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 1
resources:
  collections:
    rag-kb:
      include: ['docs']
      exclude: ['**/README.md', '**/node_modules/**']
`;
    await writeFile(configPath, content);

    const config = await parseConfigFile(configPath);

    const ragCollection = config.resources?.collections['rag-kb'];
    expect(ragCollection?.exclude).toEqual(['**/README.md', '**/node_modules/**']);
  });

  it('should throw on invalid YAML', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 1
  invalid: yaml: syntax
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid YAML');
  });

  it('should throw on missing version field', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
resources:
  collections:
    test: { include: ['docs'] }
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid config file');
  });

  it('should throw on wrong version number', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 2
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid config file');
  });

  it('should throw on collection without include', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 1
resources:
  collections:
    invalid:
      exclude: ['**/README.md']
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid config file');
  });

  it('should throw on empty include array', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 1
resources:
  collections:
    invalid:
      include: []
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid config file');
  });
});

describe('findConfigFile', () => {
  const suite = setupTempDirTestSuite('config-find-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should find config in current directory', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    await writeFile(configPath, 'version: 1\n');

    const found = await findConfigFile(suite.tempDir);
    expect(found).toBe(configPath);
  });

  it('should find config in parent directory', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    await writeFile(configPath, 'version: 1\n');

    const subDir = join(suite.tempDir, 'sub', 'deep');
    await mkdir(subDir, { recursive: true });

    const found = await findConfigFile(subDir);
    expect(found).toBe(configPath);
  });

  it('should return undefined when no config exists', async () => {
    const found = await findConfigFile(suite.tempDir);
    expect(found).toBeUndefined();
  });

  it('should stop at root directory', async () => {
    const found = await findConfigFile('/');
    expect(found).toBeUndefined();
  });
});

describe('loadConfig', () => {
  const suite = setupTempDirTestSuite('config-load-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should load config from current directory', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 1
resources:
  collections:
    test: { include: ['docs'] }
`;
    await writeFile(configPath, content);

    const config = await loadConfig(suite.tempDir);

    expect(config).toBeDefined();
    expect(config?.version).toBe(1);
    expect(config?.resources?.collections).toHaveProperty('test');
  });

  it('should load config from parent directory', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 1
resources:
  collections:
    test: { include: ['docs'] }
`;
    await writeFile(configPath, content);

    const subDir = join(suite.tempDir, 'sub');
    await mkdir(subDir);

    const config = await loadConfig(subDir);

    expect(config).toBeDefined();
    expect(config?.version).toBe(1);
  });

  it('should return undefined when no config exists', async () => {
    const config = await loadConfig(suite.tempDir);
    expect(config).toBeUndefined();
  });

  it('should throw on invalid config', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    await writeFile(configPath, 'invalid yaml: {');

    await expect(loadConfig(suite.tempDir)).rejects.toThrow('Invalid YAML');
  });
});

describe('claude: config section', () => {
  const suite = setupTempDirTestSuite('config-claude-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should parse config with no claude: section', async () => {
    const configPath = join(suite.tempDir, CONFIG_FILENAME);
    await writeFile(configPath, 'version: 1\n');

    const config = await parseConfigFile(configPath);

    expect(config.claude).toBeUndefined();
  });

  it('should parse config with claude.managedSettings', async () => {
    const configPath = join(suite.tempDir, CONFIG_FILENAME);
    const content = `
version: 1
claude:
  managedSettings: managed-settings.json
`;
    await writeFile(configPath, content);

    const config = await parseConfigFile(configPath);

    expect(config.claude?.managedSettings).toBe('managed-settings.json');
    expect(config.claude?.marketplaces).toBeUndefined();
  });

  it('should parse source-layout (file:) marketplace variant', async () => {
    const configPath = join(suite.tempDir, CONFIG_FILENAME);
    const content = `
version: 1
claude:
  marketplaces:
    my-marketplace:
      file: .claude-plugin/marketplace.json
`;
    await writeFile(configPath, content);

    const config = await parseConfigFile(configPath);

    const mp = config.claude?.marketplaces?.['my-marketplace'];
    expect(mp?.file).toBe('.claude-plugin/marketplace.json');
    expect(mp?.owner).toBeUndefined();
  });

  it('should parse inline marketplace with skills selector and plugins', async () => {
    const configPath = join(suite.tempDir, CONFIG_FILENAME);
    const content = `
version: 1
claude:
  marketplaces:
    acme-tools:
      owner:
        name: Acme Corp
        email: devtools@acme.com
      metadata:
        description: Acme developer tools
      skills:
        - acme-*
        - shared-utils
      plugins:
        - name: acme-tools
          skills: '*'
          version: 1.0.0
          license: MIT
      output:
        marketplaceJson: dist/.claude-plugin/marketplace.json
        pluginsDir: dist/plugins/
`;
    await writeFile(configPath, content);

    const config = await parseConfigFile(configPath);

    const mp = config.claude?.marketplaces?.['acme-tools'];
    expect(mp?.owner?.name).toBe('Acme Corp');
    expect(mp?.owner?.email).toBe('devtools@acme.com');
    expect(mp?.metadata?.description).toBe('Acme developer tools');
    expect(mp?.skills).toEqual(['acme-*', 'shared-utils']);
    expect(mp?.plugins).toHaveLength(1);
    expect(mp?.plugins?.[0]?.name).toBe('acme-tools');
    expect(mp?.plugins?.[0]?.skills).toBe('*');
    expect(mp?.plugins?.[0]?.version).toBe('1.0.0');
    expect(mp?.output?.marketplaceJson).toBe('dist/.claude-plugin/marketplace.json');
    expect(mp?.output?.pluginsDir).toBe('dist/plugins/');
  });

  it('should parse multiple marketplaces', async () => {
    const configPath = join(suite.tempDir, CONFIG_FILENAME);
    const content = `
version: 1
claude:
  marketplaces:
    first:
      file: .claude-plugin/marketplace.json
    second:
      owner:
        name: My Org
      skills:
        - my-skill
      plugins:
        - name: my-plugin
          skills: '*'
`;
    await writeFile(configPath, content);

    const config = await parseConfigFile(configPath);

    expect(Object.keys(config.claude?.marketplaces ?? {})).toHaveLength(2);
    expect(config.claude?.marketplaces?.['first']?.file).toBe('.claude-plugin/marketplace.json');
    expect(config.claude?.marketplaces?.['second']?.owner?.name).toBe('My Org');
  });

  it('should reject unknown fields in claude: section (strict schema)', async () => {
    const configPath = join(suite.tempDir, CONFIG_FILENAME);
    const content = `
version: 1
claude:
  unknownField: value
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid config file');
  });

  it('should reject unknown fields in marketplace plugin entry (strict schema)', async () => {
    const configPath = join(suite.tempDir, CONFIG_FILENAME);
    const content = `
version: 1
claude:
  marketplaces:
    acme-tools:
      plugins:
        - name: acme-tools
          unknownField: oops
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid config file');
  });
});

describe('collections optional', () => {
  it('should accept resources section without collections field', () => {
    const result = ProjectConfigSchema.safeParse({ version: 1, resources: { include: ['docs/**/*.md'] } });

    expect(result.success).toBe(true);
    expect(result.data?.resources?.collections).toBeUndefined();
  });

  it('should accept resources section with only exclude patterns', () => {
    const result = ProjectConfigSchema.safeParse({ version: 1, resources: { exclude: ['**/node_modules/**'] } });

    expect(result.success).toBe(true);
  });
});

describe('external URL validation config', () => {
  const suite = setupTempDirTestSuite('config-external-urls-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should parse externalUrls config', async () => {
    const configPath = join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 1
resources:
  collections:
    docs:
      include: ['docs/**/*.md']
      validation:
        externalUrls:
          enabled: true
          timeout: 10000
          retryOn429: true
          ignorePatterns: ['^https://localhost']
`;
    await writeFile(configPath, content);

    const config = await parseConfigFile(configPath);

    expect(config.resources?.collections.docs?.validation?.externalUrls?.enabled).toBe(true);
    expect(config.resources?.collections.docs?.validation?.externalUrls?.timeout).toBe(10000);
    expect(config.resources?.collections.docs?.validation?.externalUrls?.retryOn429).toBe(true);
    expect(config.resources?.collections.docs?.validation?.externalUrls?.ignorePatterns).toEqual(['^https://localhost']);
  });
});
