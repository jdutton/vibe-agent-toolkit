/* eslint-disable security/detect-non-literal-fs-filename, sonarjs/no-duplicate-string */
// Test file - all file operations are in temp directories, duplicated strings acceptable
import { mkdir, writeFile } from 'node:fs/promises';

import { safePath } from '@vibe-agent-toolkit/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadConfig, parseConfigFile } from '../src/config-parser.js';
import { ClaudeMarketplaceSchema, ProjectConfigSchema } from '../src/schemas/project-config.js';

import { setupTempDirTestSuite } from './test-helpers.js';

// Test constants
const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

describe('parseConfigFile', () => {
  const suite = setupTempDirTestSuite('config-parse-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should parse valid config file', async () => {
    const configPath = safePath.join(suite.tempDir, CONFIG_FILENAME);
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
    const configPath = safePath.join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
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
    const configPath = safePath.join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
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
    const configPath = safePath.join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 1
  invalid: yaml: syntax
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid YAML');
  });

  it('should throw on missing version field', async () => {
    const configPath = safePath.join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
resources:
  collections:
    test: { include: ['docs'] }
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid configuration in');
  });

  it('should throw on wrong version number', async () => {
    const configPath = safePath.join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 2
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid configuration in');
  });

  it('should throw on collection without include', async () => {
    const configPath = safePath.join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 1
resources:
  collections:
    invalid:
      exclude: ['**/README.md']
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid configuration in');
  });

  it('should throw on empty include array', async () => {
    const configPath = safePath.join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 1
resources:
  collections:
    invalid:
      include: []
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid configuration in');
  });
});

describe('loadConfig', () => {
  const suite = setupTempDirTestSuite('config-load-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should load config from current directory', async () => {
    const configPath = safePath.join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
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
    const configPath = safePath.join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    const content = `
version: 1
resources:
  collections:
    test: { include: ['docs'] }
`;
    await writeFile(configPath, content);

    const subDir = safePath.join(suite.tempDir, 'sub');
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
    const configPath = safePath.join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
    await writeFile(configPath, 'invalid yaml: {');

    await expect(loadConfig(suite.tempDir)).rejects.toThrow('Invalid YAML');
  });
});

describe('claude: config section', () => {
  const suite = setupTempDirTestSuite('config-claude-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should parse config with no claude: section', async () => {
    const configPath = safePath.join(suite.tempDir, CONFIG_FILENAME);
    await writeFile(configPath, 'version: 1\n');

    const config = await parseConfigFile(configPath);

    expect(config.claude).toBeUndefined();
  });

  it('should parse config with claude.managedSettings', async () => {
    const configPath = safePath.join(suite.tempDir, CONFIG_FILENAME);
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

  it('should parse inline marketplace with plugins', async () => {
    const configPath = safePath.join(suite.tempDir, CONFIG_FILENAME);
    const content = `
version: 1
claude:
  marketplaces:
    acme-tools:
      owner:
        name: Acme Corp
        email: devtools@acme.com
      plugins:
        - name: acme-tools
          description: Acme developer tools plugin
          skills: "*"
`;
    await writeFile(configPath, content);

    const config = await parseConfigFile(configPath);

    const mp = config.claude?.marketplaces?.['acme-tools'];
    expect(mp?.owner?.name).toBe('Acme Corp');
    expect(mp?.owner?.email).toBe('devtools@acme.com');
    expect(mp?.plugins).toHaveLength(1);
    expect(mp?.plugins?.[0]?.name).toBe('acme-tools');
    expect(mp?.plugins?.[0]?.description).toBe('Acme developer tools plugin');
  });

  it('should parse multiple marketplaces', async () => {
    const configPath = safePath.join(suite.tempDir, CONFIG_FILENAME);
    const content = `
version: 1
claude:
  marketplaces:
    first:
      owner:
        name: First Org
      plugins:
        - name: first-plugin
          description: First plugin
          skills: "*"
    second:
      owner:
        name: My Org
      plugins:
        - name: my-plugin
          description: My plugin
          skills: "*"
`;
    await writeFile(configPath, content);

    const config = await parseConfigFile(configPath);

    expect(Object.keys(config.claude?.marketplaces ?? {})).toHaveLength(2);
    expect(config.claude?.marketplaces?.['first']?.owner?.name).toBe('First Org');
    expect(config.claude?.marketplaces?.['second']?.owner?.name).toBe('My Org');
  });

  it('should reject unknown fields in claude: section (strict schema)', async () => {
    const configPath = safePath.join(suite.tempDir, CONFIG_FILENAME);
    const content = `
version: 1
claude:
  unknownField: value
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid configuration in');
  });

  it('should reject unknown fields in marketplace plugin entry (strict schema)', async () => {
    const configPath = safePath.join(suite.tempDir, CONFIG_FILENAME);
    const content = `
version: 1
claude:
  marketplaces:
    acme-tools:
      owner:
        name: Acme Corp
      plugins:
        - name: acme-tools
          description: Acme tools
          skills: "*"
          unknownField: oops
`;
    await writeFile(configPath, content);

    await expect(parseConfigFile(configPath)).rejects.toThrow('Invalid configuration in');
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

describe('resources section strictness', () => {
  /** Every key the section legitimately carries, so the accept direction is pinned too. */
  const EVERY_KEY = {
    include: ['docs/**/*.md'],
    exclude: ['**/node_modules/**'],
    collections: { docs: { include: ['docs/**/*.md'] } },
    validation: { severity: { EXTERNAL_URL_DEAD: 'ignore' } },
    linkAuth: { providers: [{ use: 'github' }] },
    checks: { 'no-orphans': { description: 'No orphans', sql: 'SELECT path FROM resources' } },
  };

  it('rejects a mistyped key instead of dropping every rule under it', () => {
    // 🪤 The failure this section is most likely to see. Without `.strict()` Zod
    // STRIPS `cheks`, the parse succeeds, and `vat resources check` finds a
    // `checks` key that exists and holds nothing — so the loud "no checks are
    // declared" warning cannot fire and the adopter believes a gate exists that
    // never runs. Exactly the argument ValidationConfigSchema is strict for,
    // with more at stake: the silent outcome here is an unenforced RULE.
    const result = ProjectConfigSchema.safeParse({
      version: 1,
      resources: { cheks: EVERY_KEY.checks },
    });

    expect(result.success).toBe(false);
  });

  it('does not silently keep the correctly-spelled half of a typo pair', () => {
    const result = ProjectConfigSchema.safeParse({
      version: 1,
      resources: { checks: EVERY_KEY.checks, cheks: EVERY_KEY.checks },
    });

    expect(result.success).toBe(false);
  });

  it('still accepts every legitimate key together', () => {
    // The accept direction matters as much as the reject one: a strict schema
    // that turns away a real key is a worse defect than the one it fixed.
    const result = ProjectConfigSchema.safeParse({ version: 1, resources: EVERY_KEY });

    expect(result.success).toBe(true);
    expect(new Set(Object.keys(result.data?.resources ?? {}))).toStrictEqual(new Set(Object.keys(EVERY_KEY)));
  });
});

describe('resources.validation config block', () => {
  it('should accept a resources.validation severity override', () => {
    const result = ProjectConfigSchema.safeParse({
      version: 1,
      resources: { validation: { severity: { EXTERNAL_URL_DEAD: 'ignore' } } },
    });

    expect(result.success).toBe(true);
    expect(result.data?.resources?.validation?.severity?.EXTERNAL_URL_DEAD).toBe('ignore');
  });

  it('should reject a bogus issue-code key in resources.validation.severity', () => {
    const result = ProjectConfigSchema.safeParse({
      version: 1,
      resources: { validation: { severity: { NOT_A_REAL_CODE: 'error' } } },
    });

    expect(result.success).toBe(false);
  });
});

describe('ClaudeMarketplaceSchema with publish config', () => {
  it('should accept valid publish config with all fields', () => {
    const result = ClaudeMarketplaceSchema.safeParse({
      owner: { name: 'Test Org' },
      publish: {
        branch: 'claude-marketplace',
        remote: 'origin',
        changelog: 'docs/marketplace-changelog.md',
        readme: 'docs/marketplace-readme.md',
        license: 'mit',
        sourceRepo: false,
      },
      plugins: [{ name: 'test', skills: '*' }],
    });
    expect(result.success).toBe(true);
  });

  it('should accept publish config with only license', () => {
    const result = ClaudeMarketplaceSchema.safeParse({
      owner: { name: 'Test Org' },
      publish: { license: 'mit' },
      plugins: [{ name: 'test', skills: '*' }],
    });
    expect(result.success).toBe(true);
  });

  it('should accept license as file path', () => {
    const result = ClaudeMarketplaceSchema.safeParse({
      owner: { name: 'Test Org' },
      publish: { license: './LICENSE' },
      plugins: [{ name: 'test', skills: '*' }],
    });
    expect(result.success).toBe(true);
  });

  it('should accept marketplace config without publish section', () => {
    const result = ClaudeMarketplaceSchema.safeParse({
      owner: { name: 'Test Org' },
      plugins: [{ name: 'test', skills: '*' }],
    });
    expect(result.success).toBe(true);
  });
});

describe('external URL validation config', () => {
  const suite = setupTempDirTestSuite('config-external-urls-');
  beforeEach(suite.beforeEach);
  afterEach(suite.afterEach);

  it('should parse externalUrls config', async () => {
    const configPath = safePath.join(suite.tempDir, 'vibe-agent-toolkit.config.yaml');
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
