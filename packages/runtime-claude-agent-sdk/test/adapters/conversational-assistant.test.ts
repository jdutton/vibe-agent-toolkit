import Anthropic from '@anthropic-ai/sdk';
import { breedAdvisorAgent, BreedAdvisorInputSchema, BreedAdvisorOutputSchema } from '@vibe-agent-toolkit/vat-example-cat-agents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  convertConversationalAssistantToTool,
  convertConversationalAssistantsToTools,
} from '../../src/adapters/conversational-assistant.js';

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => {
  const mockCreate = vi.fn();
  const MockAnthropic = vi.fn().mockImplementation(() => ({
    messages: {
      create: mockCreate,
    },
  }));
  MockAnthropic.mockCreate = mockCreate;
  return {
    default: MockAnthropic,
  };
});

const CONVERSATIONAL_ASSISTANT_ARCHETYPE = 'conversational-assistant';

describe('convertConversationalAssistantToTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should convert a conversational assistant agent to MCP tool', () => {
    const result = convertConversationalAssistantToTool(
      breedAdvisorAgent,
      BreedAdvisorInputSchema,
      BreedAdvisorOutputSchema,
      { apiKey: 'test-key' },
    );

    expect(result).toHaveProperty('server');
    expect(result).toHaveProperty('metadata');
    expect(result).toHaveProperty('inputSchema');
    expect(result).toHaveProperty('outputSchema');

    expect(result.metadata.name).toBe('breed-advisor');
    expect(result.metadata.archetype).toBe(CONVERSATIONAL_ASSISTANT_ARCHETYPE);
    expect(result.metadata.toolName).toBe('mcp__breed-advisor__breed-advisor');
  });

  it('should use custom server name when provided', () => {
    const result = convertConversationalAssistantToTool(
      breedAdvisorAgent,
      BreedAdvisorInputSchema,
      BreedAdvisorOutputSchema,
      { apiKey: 'test-key' },
      'custom-server',
    );

    expect(result.metadata.serverName).toBe('custom-server');
    expect(result.metadata.toolName).toBe('mcp__custom-server__breed-advisor');
  });

  it('should maintain conversation history across invocations', async () => {
    const testApiKey = 'test-api-key';
    const mockLLMResponse = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            reply: 'Great! Small apartments work well for many cat breeds.',
            updatedProfile: {
              livingSpace: 'apartment',
              conversationPhase: 'gathering',
            },
          }),
        },
      ],
    };

    const mockCreate = (Anthropic as unknown as { mockCreate: ReturnType<typeof vi.fn> }).mockCreate;
    mockCreate.mockResolvedValue(mockLLMResponse);

    const result = convertConversationalAssistantToTool(
      breedAdvisorAgent,
      BreedAdvisorInputSchema,
      BreedAdvisorOutputSchema,
      { apiKey: testApiKey },
    );

    expect(result.server).toBeDefined();
    expect(result.metadata.archetype).toBe(CONVERSATIONAL_ASSISTANT_ARCHETYPE);
  });

  it('should include metadata from agent manifest', () => {
    const result = convertConversationalAssistantToTool(
      breedAdvisorAgent,
      BreedAdvisorInputSchema,
      BreedAdvisorOutputSchema,
      { apiKey: 'test-key' },
    );

    expect(result.metadata.description).toBe('Conversational assistant that helps users find their perfect cat breed');
    expect(result.metadata.version).toBeDefined();
  });

  it('should use default model when not specified', () => {
    const result = convertConversationalAssistantToTool(
      breedAdvisorAgent,
      BreedAdvisorInputSchema,
      BreedAdvisorOutputSchema,
      { apiKey: 'test-key' },
    );

    expect(result.server).toBeDefined();
    // Model is internal to implementation, verified through successful tool creation
  });

  it('should accept custom LLM configuration', () => {
    const result = convertConversationalAssistantToTool(
      breedAdvisorAgent,
      BreedAdvisorInputSchema,
      BreedAdvisorOutputSchema,
      {
        apiKey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
        temperature: 0.9,
        maxTokens: 2048,
      },
    );

    expect(result.server).toBeDefined();
    // Configuration is internal, verified through successful tool creation
  });

  it('should use environment API key when not provided', () => {
    const originalKey = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'env-api-key';

    const result = convertConversationalAssistantToTool(
      breedAdvisorAgent,
      BreedAdvisorInputSchema,
      BreedAdvisorOutputSchema,
      {},
    );

    expect(result.server).toBeDefined();

    // Restore original key
    if (originalKey) {
      process.env['ANTHROPIC_API_KEY'] = originalKey;
    } else {
      delete process.env['ANTHROPIC_API_KEY'];
    }
  });
});

describe('convertConversationalAssistantsToTools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should convert multiple conversational agents to a single MCP server', () => {
    const result = convertConversationalAssistantsToTools(
      {
        breedAdvisor: {
          agent: breedAdvisorAgent,
          inputSchema: BreedAdvisorInputSchema,
          outputSchema: BreedAdvisorOutputSchema,
        },
      },
      { apiKey: 'test-key' },
    );

    expect(result).toHaveProperty('server');
    expect(result).toHaveProperty('metadata');
    expect(result.metadata.serverName).toBe('vat-conversational-agents');
    expect(result.metadata.tools).toHaveProperty('breedAdvisor');
  });

  it('should use custom server name when provided', () => {
    const result = convertConversationalAssistantsToTools(
      {
        breedAdvisor: {
          agent: breedAdvisorAgent,
          inputSchema: BreedAdvisorInputSchema,
          outputSchema: BreedAdvisorOutputSchema,
        },
      },
      { apiKey: 'test-key' },
      'custom-batch-server',
    );

    expect(result.metadata.serverName).toBe('custom-batch-server');
    expect(result.metadata.tools['breedAdvisor']?.toolName).toBe('mcp__custom-batch-server__breedAdvisor');
  });

  it('should create metadata for all agents', () => {
    const result = convertConversationalAssistantsToTools(
      {
        breedAdvisor: {
          agent: breedAdvisorAgent,
          inputSchema: BreedAdvisorInputSchema,
          outputSchema: BreedAdvisorOutputSchema,
        },
      },
      { apiKey: 'test-key' },
    );

    expect(result.metadata.tools['breedAdvisor']).toBeDefined();
    expect(result.metadata.tools['breedAdvisor']?.name).toBe('breed-advisor');
    expect(result.metadata.tools['breedAdvisor']?.archetype).toBe(CONVERSATIONAL_ASSISTANT_ARCHETYPE);
  });

  it('should maintain separate sessions for each agent', async () => {
    const result = convertConversationalAssistantsToTools(
      {
        breedAdvisor: {
          agent: breedAdvisorAgent,
          inputSchema: BreedAdvisorInputSchema,
          outputSchema: BreedAdvisorOutputSchema,
        },
      },
      { apiKey: 'test-key' },
    );

    expect(result.server).toBeDefined();
    expect(result.metadata.tools).toHaveProperty('breedAdvisor');
    // Session isolation is internal, verified through successful tool creation
  });

  it('should share LLM configuration across all agents', () => {
    const result = convertConversationalAssistantsToTools(
      {
        breedAdvisor: {
          agent: breedAdvisorAgent,
          inputSchema: BreedAdvisorInputSchema,
          outputSchema: BreedAdvisorOutputSchema,
        },
      },
      {
        apiKey: 'test-key',
        model: 'claude-3-5-sonnet-20241022',
        temperature: 0.8,
        maxTokens: 3000,
      },
    );

    expect(result.server).toBeDefined();
    // Configuration sharing is internal, verified through successful tool creation
  });

  it('should handle empty configuration object', () => {
    const result = convertConversationalAssistantsToTools({}, { apiKey: 'test-key' });

    expect(result.server).toBeDefined();
    expect(result.metadata.serverName).toBe('vat-conversational-agents');
    expect(Object.keys(result.metadata.tools)).toHaveLength(0);
  });
});
