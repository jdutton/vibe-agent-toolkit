
/* eslint-disable security/detect-non-literal-fs-filename -- Test code with safe temp directories */
import fs from 'node:fs';
import path from 'node:path';

import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findManifestPath, loadAgentManifest } from '../../src/loader/manifest-loader.js';

describe('manifest-loader', () => {
  let tempDir: string;
  const AGENT_YAML = 'agent.yaml';

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'vat-manifest-test-'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('findManifestPath', () => {
    it('should find agent.yaml in directory', async () => {
      const agentDir = path.join(tempDir, 'agent1');
      mkdirSyncReal(agentDir);
      fs.writeFileSync(path.join(agentDir, AGENT_YAML), 'test');

      const manifestPath = await findManifestPath(agentDir);
      expect(manifestPath).toBe(path.join(agentDir, AGENT_YAML));
    });

    it('should find agent.yml in directory', async () => {
      const agentDir = path.join(tempDir, 'agent2');
      mkdirSyncReal(agentDir);
      fs.writeFileSync(path.join(agentDir, 'agent.yml'), 'test');

      const manifestPath = await findManifestPath(agentDir);
      expect(manifestPath).toBe(path.join(agentDir, 'agent.yml'));
    });

    it('should return direct path to manifest file', async () => {
      const agentDir = path.join(tempDir, 'agent3');
      mkdirSyncReal(agentDir);
      const manifestPath = path.join(agentDir, AGENT_YAML);
      fs.writeFileSync(manifestPath, 'test');

      const result = await findManifestPath(manifestPath);
      expect(result).toBe(manifestPath);
    });

    it('should throw when no manifest found in directory', async () => {
      const agentDir = path.join(tempDir, 'empty-agent');
      mkdirSyncReal(agentDir);

      await expect(findManifestPath(agentDir)).rejects.toThrow(
        'No agent manifest found'
      );
    });

    it('should throw when manifest file does not exist', async () => {
      const nonexistent = path.join(tempDir, 'nonexistent', AGENT_YAML);

      await expect(findManifestPath(nonexistent)).rejects.toThrow();
    });
  });

  describe('loadAgentManifest', () => {
    it('should load valid agent manifest', async () => {
      const agentDir = path.join(tempDir, 'valid-agent');
      mkdirSyncReal(agentDir);
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: test-agent
  version: 0.1.0
  description: Test agent
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
`
      );

      const manifest = await loadAgentManifest(agentDir);
      expect(manifest.metadata.name).toBe('test-agent');
      expect(manifest.metadata.version).toBe('0.1.0');
      expect(manifest.spec.llm.provider).toBe('anthropic');
    });

    it('should throw on invalid YAML', async () => {
      const agentDir = path.join(tempDir, 'invalid-yaml');
      mkdirSyncReal(agentDir);
      fs.writeFileSync(path.join(agentDir, AGENT_YAML), '{ invalid yaml [');

      await expect(loadAgentManifest(agentDir)).rejects.toThrow();
    });

    it('should throw on schema validation failure', async () => {
      const agentDir = path.join(tempDir, 'invalid-schema');
      mkdirSyncReal(agentDir);
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: INVALID_NAME_WITH_CAPS
  version: 0.1.0
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
`
      );

      await expect(loadAgentManifest(agentDir)).rejects.toThrow('validation');
    });

    it('should include manifest path in loaded result', async () => {
      const agentDir = path.join(tempDir, 'agent-with-path');
      mkdirSyncReal(agentDir);
      const manifestPath = path.join(agentDir, AGENT_YAML);
      fs.writeFileSync(
        manifestPath,
        `
metadata:
  name: test-agent
  version: 0.1.0
  description: Test
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
`
      );

      const result = await loadAgentManifest(agentDir);
      expect(result.__manifestPath).toBe(manifestPath);
    });
  });
});
