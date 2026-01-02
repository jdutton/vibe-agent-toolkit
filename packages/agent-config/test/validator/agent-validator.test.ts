/* eslint-disable security/detect-non-literal-fs-filename -- Test code with safe temp directories */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { validateAgent } from '../../src/validator/agent-validator.js';
import {
  assertValidationFailedWithUnknownManifest,
  assertValidationHasError,
} from '../test-helpers.js';

describe('agent-validator', () => {
  let tempDir: string;
  const AGENT_YAML = 'agent.yaml';

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vat-validator-test-'));
  });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('validateAgent', () => {
    it('should validate agent with no tools', async () => {
      const agentDir = path.join(tempDir, 'no-tools-agent');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: simple-agent
  version: 0.1.0
  description: Simple agent
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
`
      );

      const result = await validateAgent(agentDir);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('should detect missing RAG database', async () => {
      const agentDir = path.join(tempDir, 'missing-rag-agent');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: rag-agent
  version: 0.1.0
  description: RAG agent
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
  rag:
    default:
      sources:
        - path: ./docs
`
      );

      const result = await validateAgent(agentDir);
      assertValidationHasError(result, ['RAG', 'database']);
    });

    it('should validate agent with existing RAG database', async () => {
      const agentDir = path.join(tempDir, 'valid-rag-agent');
      fs.mkdirSync(agentDir);
      fs.mkdirSync(path.join(agentDir, '.rag-db')); // Create RAG database
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: rag-agent
  version: 0.1.0
  description: RAG agent
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
  rag:
    default:
      sources:
        - path: ./docs
`
      );

      const result = await validateAgent(agentDir);
      expect(result.valid).toBe(true);
    });

    it('should detect missing resource files', async () => {
      const agentDir = path.join(tempDir, 'missing-resource-agent');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: resource-agent
  version: 0.1.0
  description: Agent with resources
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
  prompts:
    system:
      $ref: ./prompts/system.md
  resources:
    docs:
      path: ./docs/guide.md
      type: documentation
`
      );

      const result = await validateAgent(agentDir);
      assertValidationHasError(result, ['prompts/system.md', 'guide.md']);
    });

    it('should validate agent with existing resources', async () => {
      const agentDir = path.join(tempDir, 'valid-resource-agent');
      fs.mkdirSync(agentDir);
      fs.mkdirSync(path.join(agentDir, 'prompts'));
      fs.mkdirSync(path.join(agentDir, 'docs'));
      fs.writeFileSync(path.join(agentDir, 'prompts', 'system.md'), '# System');
      fs.writeFileSync(path.join(agentDir, 'docs', 'guide.md'), '# Guide');
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: resource-agent
  version: 0.1.0
  description: Agent with resources
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
  prompts:
    system:
      $ref: ./prompts/system.md
  resources:
    docs:
      path: ./docs/guide.md
      type: documentation
`
      );

      const result = await validateAgent(agentDir);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should return validation result with manifest info', async () => {
      const agentDir = path.join(tempDir, 'info-agent');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: info-agent
  version: 1.2.3
  description: Test agent
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
`
      );

      const result = await validateAgent(agentDir);
      expect(result.manifest.name).toBe('info-agent');
      expect(result.manifest.version).toBe('1.2.3');
      expect(result.manifest.path).toContain(AGENT_YAML);
    });

    it('should handle agent without version', async () => {
      const agentDir = path.join(tempDir, 'no-version-agent');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: no-version-agent
  description: Agent without version
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
`
      );

      const result = await validateAgent(agentDir);
      expect(result.manifest.version).toBe('unknown');
    });

    it('should warn when RAG config has no sources', async () => {
      const agentDir = path.join(tempDir, 'rag-no-sources-agent');
      fs.mkdirSync(agentDir);
      fs.mkdirSync(path.join(agentDir, '.rag-db')); // Create RAG database
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: rag-agent
  version: 0.1.0
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
  rag:
    default:
      provider: lancedb
`
      );

      const result = await validateAgent(agentDir);
      expect(result.valid).toBe(true);
      expect(result.warnings).toContain('RAG configuration defined but no sources specified');
    });

    it('should validate nested resources', async () => {
      const agentDir = path.join(tempDir, 'nested-resources-agent');
      fs.mkdirSync(agentDir);
      fs.mkdirSync(path.join(agentDir, 'docs'));
      fs.writeFileSync(path.join(agentDir, 'docs', 'api.md'), '# API');
      fs.writeFileSync(path.join(agentDir, 'docs', 'guide.md'), '# Guide');
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: nested-agent
  version: 0.1.0
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
  resources:
    documentation:
      api:
        path: ./docs/api.md
        type: documentation
      guide:
        path: ./docs/guide.md
        type: documentation
`
      );

      const result = await validateAgent(agentDir);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('should detect missing nested resources', async () => {
      const agentDir = path.join(tempDir, 'missing-nested-agent');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: nested-agent
  version: 0.1.0
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
  resources:
    documentation:
      api:
        path: ./docs/api.md
        type: documentation
`
      );

      const result = await validateAgent(agentDir);
      assertValidationHasError(result, ['documentation.api', 'docs/api.md']);
    });

    it('should validate user prompt', async () => {
      const agentDir = path.join(tempDir, 'user-prompt-agent');
      fs.mkdirSync(agentDir);
      fs.mkdirSync(path.join(agentDir, 'prompts'));
      fs.writeFileSync(path.join(agentDir, 'prompts', 'user.md'), '# User Prompt');
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: user-prompt-agent
  version: 0.1.0
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
  prompts:
    user:
      $ref: ./prompts/user.md
`
      );

      const result = await validateAgent(agentDir);
      expect(result.valid).toBe(true);
    });

    it('should detect missing user prompt', async () => {
      const agentDir = path.join(tempDir, 'missing-user-prompt-agent');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        `
metadata:
  name: missing-user-prompt-agent
  version: 0.1.0
spec:
  llm:
    provider: anthropic
    model: claude-sonnet-4.5
  prompts:
    user:
      $ref: ./prompts/user.md
`
      );

      const result = await validateAgent(agentDir);
      assertValidationHasError(result, ['User prompt', 'user.md']);
    });

    it('should handle invalid manifest file', async () => {
      const agentDir = path.join(tempDir, 'invalid-manifest-agent');
      fs.mkdirSync(agentDir);
      fs.writeFileSync(
        path.join(agentDir, AGENT_YAML),
        'invalid: yaml: [[[{'
      );

      const result = await validateAgent(agentDir);
      assertValidationFailedWithUnknownManifest(result);
    });

    it('should handle nonexistent manifest file', async () => {
      const agentDir = path.join(tempDir, 'nonexistent-agent');
      fs.mkdirSync(agentDir);

      const result = await validateAgent(agentDir);
      assertValidationFailedWithUnknownManifest(result, { checkVersion: false });
    });
  });
});
