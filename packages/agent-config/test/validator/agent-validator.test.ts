import fs from 'node:fs';
import fsp from 'node:fs/promises';

import { mkdirSyncReal, normalizedTmpdir, safePath } from '@vibe-agent-toolkit/utils';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { validateAgent } from '../../src/validator/agent-validator.js';
import { assertValidationHasError, createTestAgent } from '../test-helpers.js';

/** Validate `agentDir` and expect nothing found. */
async function expectCleanAgent(agentDir: string, locationRoot: string): Promise<void> {
  const result = await validateAgent(agentDir, { locationRoot });
  expect(result.status).toBe('ok');
  expect(result.issues).toEqual([]);
  expect(result.summary).toEqual({ errors: 0, warnings: 0, info: 0 });
}

describe('agent-validator', () => {
  let tempDir: string;
  const AGENT_YAML = 'agent.yaml';
  const DOCUMENTATION = 'documentation';
  const DOCS_GUIDE_MD = './docs/guide.md';
  const INFO_AGENT = 'info-agent';
  const SYSTEM_PROMPT_MD = './prompts/system.md';

  beforeAll(() => {
    tempDir = fs.mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-validator-test-'));
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

      await expectCleanAgent(agentDir, tempDir);
    });

    it('should detect missing RAG database', async () => {
      const agentDir = createTestAgent(tempDir, 'missing-rag-agent', {
        name: 'rag-agent',
        version: '0.1.0',
        description: 'RAG agent',
        rag: { sources: [{ path: './docs' }] },
      });

      const result = await validateAgent(agentDir, { locationRoot: tempDir });
      assertValidationHasError(result, 'AGENT_REFERENCE_MISSING', ['RAG', 'database']);
      // Shown relative to the manifest, like every other reference — never the
      // developer's absolute path, which a published finding must not carry.
      const message = result.issues.find((issue) => issue.code === 'AGENT_REFERENCE_MISSING')?.message;
      expect(message).toContain('RAG database not found: .rag-db.');
      expect(message).not.toContain(tempDir);
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

      const result = await validateAgent(agentDir, { locationRoot: tempDir });
      expect(result.status).toBe('ok');
    });

    it('should detect missing resource files', async () => {
      const agentDir = createTestAgent(tempDir, 'missing-resource-agent', {
        name: 'resource-agent',
        version: '0.1.0',
        description: 'Agent with resources',
        prompts: { system: SYSTEM_PROMPT_MD },
        resources: { docs: { path: DOCS_GUIDE_MD, type: DOCUMENTATION } },
      });

      const result = await validateAgent(agentDir, { locationRoot: tempDir });
      assertValidationHasError(result, 'AGENT_REFERENCE_MISSING', ['prompts/system.md', 'guide.md']);
    });

    it('should validate agent with existing resources', async () => {
      const agentDir = createTestAgent(
        tempDir,
        'valid-resource-agent',
        {
          name: 'resource-agent',
          version: '0.1.0',
          description: 'Agent with resources',
          prompts: { system: SYSTEM_PROMPT_MD },
          resources: { docs: { path: DOCS_GUIDE_MD, type: DOCUMENTATION } },
        },
        {
          'prompts/system.md': '# System',
          'docs/guide.md': '# Guide',
        }
      );

      await expectCleanAgent(agentDir, tempDir);
    });

    it('should return validation result with manifest info', async () => {
      const agentDir = createTestAgent(tempDir, INFO_AGENT, {
        name: INFO_AGENT,
        version: '1.2.3',
        description: 'Test agent',
      });

      const result = await validateAgent(agentDir, { locationRoot: tempDir });
      expect(result.manifest.name).toBe(INFO_AGENT);
      expect(result.manifest.version).toBe('1.2.3');
      expect(result.manifest.path).toContain(AGENT_YAML);
    });

    it('should handle agent without version', async () => {
      const agentDir = createTestAgent(tempDir, 'no-version-agent', {
        name: 'no-version-agent',
        description: 'Agent without version',
      });

      const result = await validateAgent(agentDir, { locationRoot: tempDir });
      expect(result.manifest.version).toBeNull();
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

      const result = await validateAgent(agentDir, { locationRoot: tempDir });
      expect(result.summary).toEqual({ errors: 0, warnings: 1, info: 0 });
      expect(result.issues).toEqual([
        expect.objectContaining({ code: 'AGENT_RAG_NO_SOURCES', severity: 'warning', location: 'rag-no-sources-agent/agent.yaml' }),
      ]);
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

      await expectCleanAgent(agentDir, tempDir);
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

      const result = await validateAgent(agentDir, { locationRoot: tempDir });
      assertValidationHasError(result, 'AGENT_REFERENCE_MISSING', [`${DOCUMENTATION}.api`, 'docs/api.md']);
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

      const result = await validateAgent(agentDir, { locationRoot: tempDir });
      expect(result.status).toBe('ok');
    });

    it('should detect missing user prompt', async () => {
      const agentDir = createTestAgent(tempDir, 'missing-user-prompt-agent', {
        name: 'missing-user-prompt-agent',
        version: '0.1.0',
        prompts: { user: './prompts/user.md' },
      });

      const result = await validateAgent(agentDir, { locationRoot: tempDir });
      assertValidationHasError(result, 'AGENT_REFERENCE_MISSING', ['User prompt', 'user.md']);
      expect(result.issues[0]?.location).toBe('missing-user-prompt-agent/agent.yaml');
    });

    it('refuses a manifest that is not YAML as unreadable, publishing no result', async () => {
      const agentDir = safePath.join(tempDir, 'invalid-manifest-agent');
      mkdirSyncReal(agentDir);
      fs.writeFileSync(
        safePath.join(agentDir, AGENT_YAML),
        'invalid: yaml: [[[{'
      );

      await expect(validateAgent(agentDir, { locationRoot: tempDir })).rejects.toMatchObject({ code: 'AGENT_MANIFEST_UNREADABLE' });
    });

    it('refuses a directory holding no manifest as not found', async () => {
      const agentDir = safePath.join(tempDir, 'nonexistent-agent');
      mkdirSyncReal(agentDir);

      await expect(validateAgent(agentDir, { locationRoot: tempDir })).rejects.toMatchObject({ code: 'AGENT_MANIFEST_NOT_FOUND' });
    });

    it('reports each schema violation of a manifest it read as a finding at the manifest', async () => {
      const agentDir = safePath.join(tempDir, 'schema-invalid-agent');
      mkdirSyncReal(agentDir);
      fs.writeFileSync(safePath.join(agentDir, AGENT_YAML), 'metadata:\n  name: x\nspec:\n  llm: 5\n');

      const result = await validateAgent(agentDir, { locationRoot: tempDir });
      expect(result.status).toBe('findings');
      expect(result.issues.length).toBeGreaterThan(0);
      for (const issue of result.issues) {
        expect(issue).toMatchObject({ code: 'AGENT_MANIFEST_INVALID', severity: 'error', location: 'schema-invalid-agent/agent.yaml' });
      }
      expect(result.issues.map((issue) => issue.field)).toContain('spec.llm');
      expect(result.manifest).toEqual({ name: null, version: null, path: safePath.join(agentDir, AGENT_YAML) });
    });

    describe('a file the OS refuses is reported as refused, not as missing', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('names the refusal for a resource that is there but unreadable', async () => {
        const agentDir = createTestAgent(
          tempDir,
          'refused-resource-agent',
          {
            name: 'refused-agent',
            version: '0.1.0',
            prompts: { system: SYSTEM_PROMPT_MD },
            resources: { docs: { path: DOCS_GUIDE_MD, type: DOCUMENTATION } },
          },
          { 'prompts/system.md': '# System', 'docs/guide.md': '# Guide' }
        );
        const refused = safePath.join(agentDir, 'docs', 'guide.md');
        const original = fsp.access.bind(fsp);
        vi.spyOn(fsp, 'access').mockImplementation(async (target, mode) => {
          if (String(target) === refused) {
            throw Object.assign(new Error(`EACCES: permission denied, access '${refused}'`), { code: 'EACCES' });
          }
          return original(target, mode);
        });

        const result = await validateAgent(agentDir, { locationRoot: tempDir });
        expect(result.status).toBe('findings');
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]?.code).toBe('AGENT_REFERENCE_UNREADABLE');
        expect(result.issues[0]?.message).toMatch(/Resource 'docs' could not be checked: .*guide\.md.*EACCES/);
        expect(result.issues[0]?.message).not.toContain('not found');
        expect(result.issues[0]?.message).not.toContain(tempDir);
      });
    });
  });
});
