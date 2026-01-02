/**
 * Tests for agent-runner utility
 *
 * Uses real temp files instead of mocking node:fs/promises to avoid
 * global mock leakage that affects other test files.
 *
 * @vitest-environment node
 * @vitest-pool forks
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as agentRunner from '../../src/utils/agent-runner.js';

// Mock the Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'Mocked response' }],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
          stop_reason: 'end_turn',
        }),
      },
    })),
  };
});

// Mock the agent-config module - will be configured per-test with real temp paths
vi.mock('@vibe-agent-toolkit/agent-config', () => ({
  loadAgentManifest: vi.fn(),
}));

// Test constants - defined after mocks due to hoisting
const TEST_AGENT_NAME = 'test-agent';
const TEST_AGENT_VERSION = '0.1.0';
const TEST_MODEL = 'claude-sonnet-4.5';
const TEST_PROVIDER = 'anthropic';
const SYSTEM_PROMPT_REF = './prompts/system.md';
const USER_PROMPT_REF = './prompts/user.md';
const MOCK_RESPONSE_TEXT = 'Mocked response';
const SYSTEM_PROMPT_CONTENT = 'You are a helpful assistant.';
const USER_PROMPT_CONTENT = 'User input: {{userInput}}';

describe('agent-runner', () => {
  let tempDir: string;
  let manifestPath: string;
  const originalEnv = process.env;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };

    // Create temp directory structure for test agent
    tempDir = await mkdtemp(join(tmpdir(), 'agent-runner-test-'));
    manifestPath = join(tempDir, 'agent.yaml');

    // Create prompts directory and files
    const promptsDir = join(tempDir, 'prompts');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- tempDir is from mkdtemp (safe)
    await mkdir(promptsDir, { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- promptsDir is from mkdtemp (safe)
    await writeFile(join(promptsDir, 'system.md'), SYSTEM_PROMPT_CONTENT);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- promptsDir is from mkdtemp (safe)
    await writeFile(join(promptsDir, 'user.md'), USER_PROMPT_CONTENT);

    // Setup default mock for loadAgentManifest
    const agentConfig = await import('@vibe-agent-toolkit/agent-config');
    const mockLoadAgentManifest = agentConfig.loadAgentManifest as ReturnType<typeof vi.fn>;
    mockLoadAgentManifest.mockResolvedValue({
      __manifestPath: manifestPath,
      metadata: {
        name: TEST_AGENT_NAME,
        version: TEST_AGENT_VERSION,
      },
      spec: {
        llm: {
          provider: TEST_PROVIDER,
          model: TEST_MODEL,
          temperature: 0.7,
          maxTokens: 4096,
        },
        prompts: {
          system: { $ref: SYSTEM_PROMPT_REF },
          user: { $ref: USER_PROMPT_REF },
        },
      },
    });
  });

  afterAll(async () => {
    // Clean up temp directory
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  // Helper to mock loadAgentManifest with custom manifest for a single test
  async function mockAgentManifestOnce(partialManifest: Record<string, unknown>): Promise<void> {
    const agentConfig = await import('@vibe-agent-toolkit/agent-config');
    const mockLoadAgentManifest = agentConfig.loadAgentManifest as ReturnType<typeof vi.fn>;
    mockLoadAgentManifest.mockResolvedValueOnce({
      __manifestPath: manifestPath,
      ...partialManifest,
    } as never);
  }

  describe('runAgent', () => {
    it('should run agent successfully with valid inputs', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'test-key';

      const result = await agentRunner.runAgent(TEST_AGENT_NAME, {
        userInput: 'Hello world',
        debug: false,
      });

      expect(result.response).toBe(MOCK_RESPONSE_TEXT);
      expect(result.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
      });
    });

    it('should throw error when API key is missing', async () => {
      delete process.env['ANTHROPIC_API_KEY'];

      await expect(
        agentRunner.runAgent(TEST_AGENT_NAME, {
          userInput: 'Hello world',
          debug: false,
        })
      ).rejects.toThrow('ANTHROPIC_API_KEY environment variable is not set');
    });

    it('should throw error for unsupported provider', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'test-key';

      await mockAgentManifestOnce({
        metadata: { name: TEST_AGENT_NAME, version: TEST_AGENT_VERSION },
        spec: {
          llm: {
            provider: 'openai',
            model: 'gpt-4',
          },
          prompts: {
            system: { $ref: SYSTEM_PROMPT_REF },
            user: { $ref: USER_PROMPT_REF },
          },
        },
      });

      await expect(
        agentRunner.runAgent(TEST_AGENT_NAME, {
          userInput: 'Hello',
          debug: false,
        })
      ).rejects.toThrow('Unsupported LLM provider: openai');
    });

    it('should handle debug mode', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'test-key';
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await agentRunner.runAgent(TEST_AGENT_NAME, {
        userInput: 'Debug test',
        debug: true,
      });

      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('should use default values when maxTokens and temperature are not set', async () => {
      process.env['ANTHROPIC_API_KEY'] = 'test-key';

      await mockAgentManifestOnce({
        metadata: { name: TEST_AGENT_NAME, version: TEST_AGENT_VERSION },
        spec: {
          llm: {
            provider: TEST_PROVIDER,
            model: TEST_MODEL,
            // No temperature or maxTokens
          },
          prompts: {
            system: { $ref: SYSTEM_PROMPT_REF },
            user: { $ref: USER_PROMPT_REF },
          },
        },
      });

      const result = await agentRunner.runAgent(TEST_AGENT_NAME, {
        userInput: 'Test',
        debug: false,
      });

      expect(result.response).toBe(MOCK_RESPONSE_TEXT);
    });
  });
});
