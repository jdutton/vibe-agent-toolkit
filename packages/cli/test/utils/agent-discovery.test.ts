
/* eslint-disable security/detect-non-literal-fs-filename -- Test code using temp directories */
import fs from 'node:fs/promises';
import path from 'node:path';

import { setupAsyncTempDirSuite } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  discoverAgents,
  findAgentByName,
  resolveAgentPath,
} from '../../src/utils/agent-discovery.js';

describe('agent-discovery', () => {
  const suite = setupAsyncTempDirSuite('agent-discovery');
  let tempDir: string;
  let originalCwd: string;

  const METADATA_YAML = 'metadata:\n  name:';
  const VERSION_YAML = '\n  version:';
  const AGENT_YAML = 'agent.yaml';
  const CURRENT_AGENT = 'current-agent';

  beforeAll(async () => {
    originalCwd = process.cwd();
    await suite.beforeAll();
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    await suite.afterAll();
  });

  beforeEach(async () => {
    await suite.beforeEach();
    tempDir = suite.getTempDir();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  describe('discoverAgents', () => {
    it('should discover agents in packages/vat-development-agents/agents', async () => {
      // Setup
      const agentPath = path.join(tempDir, 'packages/vat-development-agents/agents/test-agent');
      await fs.mkdir(agentPath, { recursive: true });
      await fs.writeFile(
        path.join(agentPath, AGENT_YAML),
        `${METADATA_YAML} test-agent${VERSION_YAML} 1.0.0\n`
      );

      // Execute
      const agents = await discoverAgents();

      // Verify
      expect(agents).toHaveLength(1);
      expect(agents[0]?.name).toBe('test-agent');
      expect(agents[0]?.version).toBe('1.0.0');
      expect(agents[0]?.path).toContain('test-agent');
      expect(agents[0]?.manifestPath).toContain(AGENT_YAML);
    });

    it('should discover agents in agents directory', async () => {
      // Setup
      const agentPath = path.join(tempDir, 'agents/my-agent');
      await fs.mkdir(agentPath, { recursive: true });
      await fs.writeFile(
        path.join(agentPath, 'agent.yml'),
        `${METADATA_YAML} my-agent${VERSION_YAML} 2.0.0\n`
      );

      // Execute
      const agents = await discoverAgents();

      // Verify
      expect(agents).toHaveLength(1);
      expect(agents[0]?.name).toBe('my-agent');
      expect(agents[0]?.version).toBe('2.0.0');
      expect(agents[0]?.path).toContain('my-agent');
      expect(agents[0]?.manifestPath).toContain('agent.yml');
    });

    it('should discover agents in current directory', async () => {
      // Setup
      const agentPath = path.join(tempDir, CURRENT_AGENT);
      await fs.mkdir(agentPath, { recursive: true });
      await fs.writeFile(
        path.join(agentPath, AGENT_YAML),
        `${METADATA_YAML} current-agent${VERSION_YAML} 3.0.0\n`
      );

      // Execute
      const agents = await discoverAgents();

      // Verify
      expect(agents).toHaveLength(1);
      expect(agents[0]).toMatchObject({
        name: CURRENT_AGENT,
        version: '3.0.0',
      });
    });

    it('should discover agents in all locations', async () => {
      // Setup multiple agents
      const vatPath = path.join(tempDir, 'packages/vat-development-agents/agents/vat-agent');
      const agentsPath = path.join(tempDir, 'agents/agents-agent');
      const currentPath = path.join(tempDir, CURRENT_AGENT);

      await fs.mkdir(vatPath, { recursive: true });
      await fs.writeFile(
        path.join(vatPath, AGENT_YAML),
        `${METADATA_YAML} vat-agent${VERSION_YAML} 1.0.0\n`
      );

      await fs.mkdir(agentsPath, { recursive: true });
      await fs.writeFile(
        path.join(agentsPath, AGENT_YAML),
        `${METADATA_YAML} agents-agent${VERSION_YAML} 2.0.0\n`
      );

      await fs.mkdir(currentPath, { recursive: true });
      await fs.writeFile(
        path.join(currentPath, AGENT_YAML),
        `${METADATA_YAML} current-agent${VERSION_YAML} 3.0.0\n`
      );

      // Execute
      const agents = await discoverAgents();

      // Verify
      expect(agents).toHaveLength(3);
      expect(agents.map(a => a.name).sort((a, b) => a.localeCompare(b))).toEqual(['agents-agent', CURRENT_AGENT, 'vat-agent']);
    });

    it('should return empty array when no agents found', async () => {
      // Execute (empty directory)
      const agents = await discoverAgents();

      // Verify
      expect(agents).toEqual([]);
    });

    it('should skip directories without manifests', async () => {
      // Setup
      const agentWithManifest = path.join(tempDir, 'agents/has-manifest');
      const agentWithoutManifest = path.join(tempDir, 'agents/no-manifest');

      await fs.mkdir(agentWithManifest, { recursive: true });
      await fs.writeFile(
        path.join(agentWithManifest, AGENT_YAML),
        `${METADATA_YAML} has-manifest${VERSION_YAML} 1.0.0\n`
      );

      await fs.mkdir(agentWithoutManifest, { recursive: true });
      await fs.writeFile(path.join(agentWithoutManifest, 'README.md'), '# No manifest');

      // Execute
      const agents = await discoverAgents();

      // Verify
      expect(agents).toHaveLength(1);
      expect(agents[0]?.name).toBe('has-manifest');
    });

    it('should skip manifests with missing metadata', async () => {
      // Setup
      const validAgent = path.join(tempDir, 'agents/valid');
      const invalidAgent1 = path.join(tempDir, 'agents/no-name');
      const invalidAgent2 = path.join(tempDir, 'agents/no-version');

      await fs.mkdir(validAgent, { recursive: true });
      await fs.writeFile(
        path.join(validAgent, AGENT_YAML),
        `${METADATA_YAML} valid${VERSION_YAML} 1.0.0\n`
      );

      await fs.mkdir(invalidAgent1, { recursive: true });
      await fs.writeFile(
        path.join(invalidAgent1, AGENT_YAML),
        `${METADATA_YAML.replace('name:', 'version:')} 1.0.0\n`
      );

      await fs.mkdir(invalidAgent2, { recursive: true });
      await fs.writeFile(
        path.join(invalidAgent2, AGENT_YAML),
        `${METADATA_YAML} no-version\n`
      );

      // Execute
      const agents = await discoverAgents();

      // Verify
      expect(agents).toHaveLength(1);
      expect(agents[0]?.name).toBe('valid');
    });

    it('should skip manifests with invalid YAML', async () => {
      // Setup
      const validAgent = path.join(tempDir, 'agents/valid');
      const invalidAgent = path.join(tempDir, 'agents/invalid-yaml');

      await fs.mkdir(validAgent, { recursive: true });
      await fs.writeFile(
        path.join(validAgent, AGENT_YAML),
        `${METADATA_YAML} valid${VERSION_YAML} 1.0.0\n`
      );

      await fs.mkdir(invalidAgent, { recursive: true });
      await fs.writeFile(
        path.join(invalidAgent, AGENT_YAML),
        'invalid: yaml: content: [[[{'
      );

      // Execute
      const agents = await discoverAgents();

      // Verify
      expect(agents).toHaveLength(1);
      expect(agents[0]?.name).toBe('valid');
    });

    it('should prefer agent.yaml over agent.yml', async () => {
      // Setup
      const agentPath = path.join(tempDir, 'agents/test-agent');
      await fs.mkdir(agentPath, { recursive: true });

      // Create both files, but .yaml should be preferred
      await fs.writeFile(
        path.join(agentPath, AGENT_YAML),
        `${METADATA_YAML} from-yaml${VERSION_YAML} 1.0.0\n`
      );
      await fs.writeFile(
        path.join(agentPath, 'agent.yml'),
        `${METADATA_YAML} from-yml${VERSION_YAML} 2.0.0\n`
      );

      // Execute
      const agents = await discoverAgents();

      // Verify
      expect(agents).toHaveLength(1);
      expect(agents[0]?.name).toBe('from-yaml');
      expect(agents[0]?.manifestPath).toContain(AGENT_YAML);
    });
  });

  describe('findAgentByName', () => {
    beforeEach(async () => {
      // Setup test agents
      const agent1Path = path.join(tempDir, 'agents/agent-one');
      const agent2Path = path.join(tempDir, 'agents/agent-two');

      await fs.mkdir(agent1Path, { recursive: true });
      await fs.writeFile(
        path.join(agent1Path, AGENT_YAML),
        `${METADATA_YAML} agent-one${VERSION_YAML} 1.0.0\n`
      );

      await fs.mkdir(agent2Path, { recursive: true });
      await fs.writeFile(
        path.join(agent2Path, AGENT_YAML),
        `${METADATA_YAML} agent-two${VERSION_YAML} 2.0.0\n`
      );
    });

    it('should find agent by name', async () => {
      // Execute
      const agent = await findAgentByName('agent-one');

      // Verify
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('agent-one');
      expect(agent?.version).toBe('1.0.0');
    });

    it('should return null when agent not found', async () => {
      // Execute
      const agent = await findAgentByName('nonexistent');

      // Verify
      expect(agent).toBeNull();
    });

    it('should find different agents by name', async () => {
      // Execute
      const agent1 = await findAgentByName('agent-one');
      const agent2 = await findAgentByName('agent-two');

      // Verify
      expect(agent1?.name).toBe('agent-one');
      expect(agent2?.name).toBe('agent-two');
    });
  });

  describe('resolveAgentPath', () => {
    beforeEach(async () => {
      // Setup test agent
      const agentPath = path.join(tempDir, 'agents/my-agent');
      await fs.mkdir(agentPath, { recursive: true });
      await fs.writeFile(
        path.join(agentPath, AGENT_YAML),
        `${METADATA_YAML} my-agent${VERSION_YAML} 1.0.0\n`
      );
    });

    it('should return path as-is when it contains forward slash', async () => {
      // Execute
      const result = await resolveAgentPath('path/to/agent');

      // Verify
      expect(result).toBe('path/to/agent');
    });

    it('should return path as-is when it contains backslash', async () => {
      // Execute
      const result = await resolveAgentPath(String.raw`path\to\agent`);

      // Verify
      expect(result).toBe(String.raw`path\to\agent`);
    });

    it('should return path as-is when it ends with .yaml', async () => {
      // Execute
      const result = await resolveAgentPath(AGENT_YAML);

      // Verify
      expect(result).toBe(AGENT_YAML);
    });

    it('should return path as-is when it ends with .yml', async () => {
      // Execute
      const result = await resolveAgentPath('agent.yml');

      // Verify
      expect(result).toBe('agent.yml');
    });

    it('should resolve agent name to path', async () => {
      // Execute
      const result = await resolveAgentPath('my-agent');

      // Verify
      expect(result).toContain('agents');
      expect(result).toContain('my-agent');
    });

    it('should return name as-is when agent not found', async () => {
      // Execute
      const result = await resolveAgentPath('nonexistent');

      // Verify
      expect(result).toBe('nonexistent');
    });

    it('should log debug messages when logger provided', async () => {
      // Setup
      const debugMessages: string[] = [];
      const logger = {
        debug: (msg: string) => debugMessages.push(msg),
      };

      // Execute
      await resolveAgentPath('my-agent', logger);

      // Verify
      expect(debugMessages).toHaveLength(2);
      expect(debugMessages[0]).toContain('Looking up agent by name: my-agent');
      expect(debugMessages[1]).toContain('Found agent: my-agent');
    });

    it('should log when agent not found', async () => {
      // Setup
      const debugMessages: string[] = [];
      const logger = {
        debug: (msg: string) => debugMessages.push(msg),
      };

      // Execute
      await resolveAgentPath('nonexistent', logger);

      // Verify
      expect(debugMessages).toHaveLength(2);
      expect(debugMessages[0]).toContain('Looking up agent by name: nonexistent');
      expect(debugMessages[1]).toContain('No agent found with name');
      expect(debugMessages[1]).toContain('treating as path');
    });

    it('should not log when logger not provided', async () => {
      // Execute (should not throw)
      const result = await resolveAgentPath('my-agent');

      // Verify
      expect(result).toBeDefined();
    });
  });
});
