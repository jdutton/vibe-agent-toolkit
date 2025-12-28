import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { DEFAULT_CONFIG } from '../../src/schemas/config.js';
import { loadConfig } from '../../src/utils/config-loader.js';

describe('loadConfig', () => {
  let tempDir: string;
  const CONFIG_FILENAME = 'vibe-agent-toolkit.config.yaml';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vat-config-test-'));
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
  include:
    - "docs/**/*.md"
  exclude:
    - "node_modules/**"
`;
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- test temp directory
    fs.writeFileSync(configPath, configContent);

    const result = loadConfig(tempDir);
    expect(result.resources?.include).toEqual(['docs/**/*.md']);
    expect(result.resources?.exclude).toEqual(['node_modules/**']);
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
});
