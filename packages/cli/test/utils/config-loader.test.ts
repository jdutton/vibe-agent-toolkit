import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/schemas/config.js';
import { loadConfig } from '../../src/utils/config-loader.js';

describe('loadConfig', () => {
  let tempDir: string;
  const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'vat-config-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return default config when no file exists', () => {
    const result = loadConfig(tempDir);
    expect(result).toEqual(DEFAULT_CONFIG);
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
    expect(result.resources?.exclude).toEqual(['node_modules/**']);
    expect(result.resources?.collections?.docs?.include).toEqual(['docs/**/*.md']);
  });

  it('should throw on invalid config schema', () => {
    const configPath = path.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 2\n`; // Invalid version
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    expect(() => loadConfig(tempDir)).toThrow();
  });

  it('should reject unknown properties at root level (strict validation)', () => {
    const configPath = path.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 1
unknownProperty: "should fail"
`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    expect(() => loadConfig(tempDir)).toThrow(/unrecognized_keys/);
  });

  it('should reject unknown properties in resources section (strict validation)', () => {
    const configPath = path.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 1
resources:
  defaults:
    exclude: ["node_modules/**"]
`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    expect(() => loadConfig(tempDir)).toThrow(/unrecognized_keys/);
    expect(() => loadConfig(tempDir)).toThrow(/defaults/);
  });

  it('should reject unknown properties in resources alongside valid ones', () => {
    const configPath = path.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 1
resources:
  exclude: ["node_modules/**"]
  unknownField: "should fail"
`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    expect(() => loadConfig(tempDir)).toThrow(/unrecognized_keys/);
    expect(() => loadConfig(tempDir)).toThrow(/unknownField/);
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
      metadata:
        defaults:
          type: documentation
    examples:
      include:
        - "./examples/**/*.yaml"
      metadata:
        defaults:
          type: example
          tags: [example]
`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    const result = loadConfig(tempDir);
    expect(result.resources?.collections).toBeDefined();
    expect(result.resources?.collections?.['project-docs']).toBeDefined();
    expect(result.resources?.collections?.['project-docs']?.include).toEqual([
      './docs/**/*.md',
      './README.md',
    ]);
    expect(result.resources?.collections?.['examples']?.metadata?.defaults?.type).toBe(
      'example'
    );
  });

  it('should load config with agents discovery', () => {
    const configPath = path.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 1
agents:
  include:
    - "./packages/vat-development-agents/**"
    - "./tools/custom-validator/agent.yaml"
  exclude:
    - "**/node_modules/**"
  external:
    - "@vat-agents/schema-validator@^1.2.0"
`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    const result = loadConfig(tempDir);
    expect(result.agents).toBeDefined();
    expect(result.agents?.include).toEqual([
      './packages/vat-development-agents/**',
      './tools/custom-validator/agent.yaml',
    ]);
    expect(result.agents?.external).toEqual(['@vat-agents/schema-validator@^1.2.0']);
  });

  it('should load config with RAG stores', () => {
    const configPath = path.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 1
rag:
  defaults:
    embedding:
      provider: transformers-js
      model: all-MiniLM-L6-v2
    chunking:
      targetSize: 512
      paddingFactor: 0.9
  stores:
    docs-rag:
      db: ./dist/docs-rag
      resources: project-docs
      embedding:
        provider: openai
        model: text-embedding-3-small
    examples-rag:
      db: ./dist/examples-rag
      resources: examples
`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    const result = loadConfig(tempDir);
    expect(result.rag).toBeDefined();
    expect(result.rag?.defaults?.embedding?.provider).toBe('transformers-js');
    expect(result.rag?.stores).toBeDefined();
    expect(result.rag?.stores?.['docs-rag']).toBeDefined();
    expect(result.rag?.stores?.['docs-rag']?.db).toBe('./dist/docs-rag');
    expect(result.rag?.stores?.['docs-rag']?.resources).toBe('project-docs');
    expect(result.rag?.stores?.['docs-rag']?.embedding?.provider).toBe('openai');
  });

  it('should load complete config with all sections', () => {
    const configPath = path.join(tempDir, CONFIG_FILENAME);
    const configContent = `version: 1
resources:
  exclude:
    - "**/node_modules/**"
  metadata:
    frontmatter: true
  collections:
    docs:
      include:
        - "./docs/**/*.md"
agents:
  include:
    - "./agents/**"
rag:
  defaults:
    embedding:
      provider: transformers-js
      model: Xenova/all-MiniLM-L6-v2
  stores:
    main:
      db: ./dist/rag-db
      resources: docs
`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    const result = loadConfig(tempDir);
    expect(result.version).toBe(1);
    expect(result.resources?.collections?.docs).toBeDefined();
    expect(result.agents?.include).toEqual(['./agents/**']);
    expect(result.rag?.stores?.main?.db).toBe('./dist/rag-db');
  });
});
