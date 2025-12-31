/**
 * Tests for agent-runner utility
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

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

// Mock the agent-config module
vi.mock('@vibe-agent-toolkit/agent-config', () => ({
  loadAgentManifest: vi.fn().mockResolvedValue({
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- Test mock path
    __manifestPath: '/tmp/test-agent/agent.yaml',
    metadata: {
      name: 'test-agent',
      version: '0.1.0',
    },
    spec: {
      llm: {
        provider: 'anthropic',
        model: 'claude-sonnet-4.5',
        temperature: 0.7,
        maxTokens: 4096,
      },
      prompts: {
        system: { $ref: './prompts/system.md' },
        user: { $ref: './prompts/user.md' },
      },
    },
  }),
}));

// Test constants - defined after mocks due to hoisting
const TEST_AGENT_NAME = 'test-agent';
const TEST_AGENT_VERSION = '0.1.0';
const TEST_MODEL = 'claude-sonnet-4.5';
const TEST_PROVIDER = 'anthropic';
// eslint-disable-next-line sonarjs/publicly-writable-directories -- Test mock path, not used for actual file operations
const TEST_MANIFEST_PATH = '/tmp/test-agent/agent.yaml';
const SYSTEM_PROMPT_REF = './prompts/system.md';
const USER_PROMPT_REF = './prompts/user.md';
const MOCK_RESPONSE_TEXT = 'Mocked response';

// Mock fs promises
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockImplementation((path: string) => {
    if (path.includes('system.md')) {
      return Promise.resolve('You are a helpful assistant.');
    }
    if (path.includes('user.md')) {
      return Promise.resolve('User input: {{userInput}}');
    }
    return Promise.reject(new Error('File not found'));
  }),
}));

// Helper to mock loadAgentManifest with custom manifest
async function mockAgentManifestOnce(partialManifest: Record<string, unknown>): Promise<void> {
  const agentConfig = await import('@vibe-agent-toolkit/agent-config');
  const mockLoadAgentManifest = agentConfig.loadAgentManifest as ReturnType<typeof vi.fn>;
  mockLoadAgentManifest.mockResolvedValueOnce(partialManifest as never);
}

describe('agent-runner', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

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
        __manifestPath: TEST_MANIFEST_PATH,
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
        __manifestPath: TEST_MANIFEST_PATH,
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
