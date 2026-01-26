/**
 * Claude Agent SDK adapter for conversational demo
 */

import { convertConversationalAssistantToTool } from '@vibe-agent-toolkit/runtime-claude-agent-sdk';
import type { Session } from '@vibe-agent-toolkit/transports';

import { breedAdvisorAgent } from '../../src/conversational-assistant/breed-advisor.js';
import {
  BreedAdvisorInputSchema,
  type BreedAdvisorInput,
  type BreedAdvisorOutput,
  BreedAdvisorOutputSchema,
} from '../../src/types/schemas.js';
import type { ConversationalRuntimeAdapter } from '../conversational-runtime-adapter.js';

import type { BreedAdvisorState } from './shared-types.js';

/**
 * Create Claude Agent SDK adapter for breed advisor
 */
export function createClaudeAgentSDKAdapter(): ConversationalRuntimeAdapter<
  BreedAdvisorOutput,
  BreedAdvisorState
> {
  const { server } = convertConversationalAssistantToTool(
    breedAdvisorAgent,
    BreedAdvisorInputSchema,
    BreedAdvisorOutputSchema,
    {
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      model: 'claude-3-5-haiku-20241022',
      temperature: 0.7,
    },
  );

  return {
    name: 'Claude Agent SDK',
    convertToFunction: async (userMessage: string, session: Session<BreedAdvisorState>) => {
      // Claude Agent SDK uses MCP tool pattern
      // For demo purposes, we'll use the tool's handler function directly
      const tool = server.tools[0]; // Get the breed-advisor tool
      if (!tool) {
        throw new Error('Tool not found in MCP server');
      }

      // Create agent input
      const agentInput: BreedAdvisorInput = {
        message: userMessage,
        sessionState: session.state ? { profile: session.state.profile } : undefined,
      };

      // Execute tool handler with session
      const result = (await tool.handler({ ...agentInput, session })) as BreedAdvisorOutput & {
        session: { history: typeof session.history; state?: unknown };
      };

      // Update session state
      const updatedState: BreedAdvisorState = {
        profile: result.sessionState,
      };

      return {
        output: result,
        session: {
          history: result.session?.history ?? session.history,
          state: updatedState,
        },
      };
    },
  };
}
