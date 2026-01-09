
/* eslint-disable security/detect-non-literal-fs-filename -- Test code with safe temp directories */
import fs from 'node:fs';
import path from 'node:path';

import { mkdirSyncReal, normalizedTmpdir } from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateAgent } from '../../src/validator/agent-validator.js';
import {
  assertValidationFailedWithUnknownManifest,
  assertValidationHasError,
  createTestAgent,
} from '../test-helpers.js';

describe('agent-validator', () => {
  let tempDir: string;
  const AGENT_YAML = 'agent.yaml';
  const DOCUMENTATION = 'documentation';
  const DOCS_GUIDE_MD = './docs/guide.md';
  const INFO_AGENT = 'info-agent';

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(normalizedTmpdir(), 'vat-validator-test-'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('validateAgent', () => {
    it('should validate agent with no tools', async () => {
      const agentDir = createTestAgent(tempDir, 'no-tools-agent', {
        name: 'simple-agent',
        version: '0.1.0',
        description: 'Simple agent',
      });

      const result = await validateAgent(agentDir);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('should detect missing RAG database', async () => {
      const agentDir = createTestAgent(tempDir, 'missing-rag-agent', {
        name: 'rag-agent',
        version: '0.1.0',
        description: 'RAG agent',
        rag: { sources: [{ path: './docs' }] },
      });

      const result = await validateAgent(agentDir);
      assertValidationHasError(result, ['RAG', 'database']);
    });

    it('should validate agent with existing RAG database', async () => {
      const agentDir = createTestAgent(
        tempDir,
        'valid-rag-agent',
        {
          name: 'rag-agent',
          version: '0.1.0',
          description: 'RAG agent',
          rag: { sources: [{ path: './docs' }] },
        },
        { '.rag-db/.keep': '' }
      );

      const result = await validateAgent(agentDir);
      expect(result.valid).toBe(true);
    });

    it('should detect missing resource files', async () => {
      const agentDir = createTestAgent(tempDir, 'missing-resource-agent', {
        name: 'resource-agent',
        version: '0.1.0',
        description: 'Agent with resources',
        prompts: { system: './prompts/system.md' },
        resources: { docs: { path: DOCS_GUIDE_MD, type: DOCUMENTATION } },
      });

      const result = await validateAgent(agentDir);
      assertValidationHasError(result, ['prompts/system.md', 'guide.md']);
    });

    it('should validate agent with existing resources', async () => {
      const agentDir = createTestAgent(
        tempDir,
        'valid-resource-agent',
        {
          name: 'resource-agent',
          version: '0.1.0',
          description: 'Agent with resources',
          prompts: { system: './prompts/system.md' },
          resources: { docs: { path: DOCS_GUIDE_MD, type: DOCUMENTATION } },
        },
        {
          'prompts/system.md': '# System',
          'docs/guide.md': '# Guide',
        }
      );

      const result = await validateAgent(agentDir);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should return validation result with manifest info', async () => {
      const agentDir = createTestAgent(tempDir, INFO_AGENT, {
        name: INFO_AGENT,
        version: '1.2.3',
        description: 'Test agent',
      });

      const result = await validateAgent(agentDir);
      expect(result.manifest.name).toBe(INFO_AGENT);
      expect(result.manifest.version).toBe('1.2.3');
      expect(result.manifest.path).toContain(AGENT_YAML);
    });

    it('should handle agent without version', async () => {
      const agentDir = createTestAgent(tempDir, 'no-version-agent', {
        name: 'no-version-agent',
        description: 'Agent without version',
      });

      const result = await validateAgent(agentDir);
      expect(result.manifest.version).toBe('unknown');
    });

    it('should warn when RAG config has no sources', async () => {
      const agentDir = createTestAgent(
        tempDir,
        'rag-no-sources-agent',
        {
          name: 'rag-agent',
          version: '0.1.0',
          rag: { provider: 'lancedb' },
        },
        { '.rag-db/.keep': '' }
      );

      const result = await validateAgent(agentDir);
      expect(result.valid).toBe(true);
      expect(result.warnings).toContain('RAG configuration defined but no sources specified');
    });

    it('should validate nested resources', async () => {
      const agentDir = createTestAgent(
        tempDir,
        'nested-resources-agent',
        {
          name: 'nested-agent',
          version: '0.1.0',
          resources: {
            [DOCUMENTATION]: {
              api: { path: './docs/api.md', type: DOCUMENTATION },
              guide: { path: DOCS_GUIDE_MD, type: DOCUMENTATION },
            },
          },
        },
        {
          'docs/api.md': '# API',
          'docs/guide.md': '# Guide',
        }
      );

      const result = await validateAgent(agentDir);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should detect missing nested resources', async () => {
      const agentDir = createTestAgent(tempDir, 'missing-nested-agent', {
        name: 'nested-agent',
        version: '0.1.0',
        resources: {
          [DOCUMENTATION]: {
            api: { path: './docs/api.md', type: DOCUMENTATION },
          },
        },
      });

      const result = await validateAgent(agentDir);
      assertValidationHasError(result, [`${DOCUMENTATION}.api`, 'docs/api.md']);
    });

    it('should validate user prompt', async () => {
      const agentDir = createTestAgent(
        tempDir,
        'user-prompt-agent',
        {
          name: 'user-prompt-agent',
          version: '0.1.0',
          prompts: { user: './prompts/user.md' },
        },
        { 'prompts/user.md': '# User Prompt' }
      );

      const result = await validateAgent(agentDir);
      expect(result.valid).toBe(true);
    });

    it('should detect missing user prompt', async () => {
      const agentDir = createTestAgent(tempDir, 'missing-user-prompt-agent', {
        name: 'missing-user-prompt-agent',
        version: '0.1.0',
        prompts: { user: './prompts/user.md' },
      });

      const result = await validateAgent(agentDir);
      assertValidationHasError(result, ['User prompt', 'user.md']);
    });

    it('should handle invalid manifest file', async () => {
      const agentDir = path.join(tempDir, 'invalid-manifest-agent');
      mkdirSyncReal(agentDir);
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        'invalid: yaml: [[[{'
      );

      const result = await validateAgent(agentDir);
      assertValidationFailedWithUnknownManifest(result);
    });

    it('should handle nonexistent manifest file', async () => {
      const agentDir = path.join(tempDir, 'nonexistent-agent');
      mkdirSyncReal(agentDir);

      const result = await validateAgent(agentDir);
      assertValidationFailedWithUnknownManifest(result, { checkVersion: false });
    });
  });
});
