/**
 * Test: Claude Agent SDK adapter for conversational demo
 *
 * Runs shared contract tests plus Claude-specific tests.
 */

import { describe, expect, it, vi } from 'vitest';

import { createClaudeAgentSDKAdapter } from '../../examples/conversational-adapters/claude-agent-sdk-adapter.js';

import { testConversationalAdapterContract } from './shared-contract-tests.js';
import { testAdapterCreation, testMissingAPIKey } from './test-helpers.js';

// Factory function for creating mock agent (must be defined before vi.mock() for hoisting)
function createMockAgent() {
  return {
    name: 'breed-advisor',
    manifest: {
      name: 'breed-advisor',
      archetype: 'two-phase-conversational-assistant',
      description: 'Test agent',
      version: '1.0.0',
    },
    execute: vi.fn().mockImplementation((input: { message: string; sessionState?: { profile?: Record<string, unknown> } }, context: { addToHistory: (role: string, content: string) => void }) => {
      const { message, sessionState } = input;
      const currentState = sessionState?.profile ?? {};

      // Add user message to history
      context.addToHistory('user', message);

      // Extract info from user message (simple pattern matching)
      const newState = { ...currentState };

      if (/apartment|small.*apartment/i.test(message)) {
        newState.livingSpace = 'apartment';
      }
      if (/jazz/i.test(message)) {
        newState.musicPreference = 'jazz';
      }
      if (/classical/i.test(message)) {
        newState.musicPreference = 'classical';
      }
      if (/calm|low.energy|lazy/i.test(message)) {
        newState.activityLevel = 'couch-companion';
      }

      const reply = 'Mocked agent response';

      // Add assistant response to history
      context.addToHistory('assistant', reply);

      return Promise.resolve({
        reply,
        sessionState: newState,
        result: { status: 'in-progress' },
      });
    }),
  };
}

// Mock Anthropic SDK
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'Mocked LLM response' }],
      }),
    },
  })),
}));

// Mock the breed advisor agent with realistic extraction
vi.mock('../../src/conversational-assistant/breed-advisor.js', () => ({
  breedAdvisorAgent: createMockAgent(),
}));

// Run shared contract tests
testConversationalAdapterContract('Claude Agent SDK', createClaudeAgentSDKAdapter);

describe('Claude Agent SDK Adapter - Claude-Specific Tests', () => {
  it('should create adapter successfully', () => {
    testAdapterCreation('Claude Agent SDK', createClaudeAgentSDKAdapter);
  });

  it('should not throw when ANTHROPIC_API_KEY is not set', () => {
    testMissingAPIKey('ANTHROPIC_API_KEY', createClaudeAgentSDKAdapter);
  });

  it('should not access internal MCP server properties', async () => {
    // This test ensures we don't regress to accessing server.tools[0]
    // which was the original bug
    const adapter = createClaudeAgentSDKAdapter();

    // Adapter should only expose name and convertToFunction
    const adapterKeys = Object.keys(adapter);
    expect(adapterKeys).toHaveLength(2);
    expect(adapterKeys).toContain('name');
    expect(adapterKeys).toContain('convertToFunction');

    // Should not have 'server' property (original bug)
    expect('server' in adapter).toBe(false);
  });
});
