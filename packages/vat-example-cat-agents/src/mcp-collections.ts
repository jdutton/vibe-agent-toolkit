/**
 * MCP Collections for vat-example-cat-agents
 *
 * Exports agent collections that can be exposed via MCP Gateway.
 * Discoverable by: vat mcp serve @vibe-agent-toolkit/vat-example-cat-agents
 */

import type { Agent, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import { createSuccess } from '@vibe-agent-toolkit/agent-schema';

import { photoAnalyzerAgent } from './one-shot-llm-analyzer/photo-analyzer.js';
import { haikuValidatorAgent } from './pure-function-tool/haiku-validator.js';

export interface MCPAgentRegistration {
  name: string;
  agent: Agent<unknown, OneShotAgentOutput<unknown, string>>;
  description: string;
}

export interface MCPCollection {
  name: string;
  description: string;
  agents: MCPAgentRegistration[];
}

/**
 * Wraps stateless agents to return OneShotAgentOutput envelope
 *
 * Gateway expects: { result: AgentResult<TData, TError>, metadata?: ... }
 * Stateless agents return: TData directly
 */
function wrapStatelessAgent<TInput, TOutput>(
  agent: { name: string; manifest: unknown; execute: (input: TInput) => TOutput | Promise<TOutput> }
): Agent<TInput, OneShotAgentOutput<TOutput, string>> {
  return {
    name: agent.name,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Accept any manifest structure from different agent types
    manifest: agent.manifest as any,
    execute: async (input: TInput) => {
      const data = await Promise.resolve(agent.execute(input));
      return {
        result: createSuccess(data),
      };
    },
  };
}

/**
 * Cat agents collection
 */
export const catAgents: MCPCollection = {
  name: 'cat-agents',
  description: 'Example cat breeding agents (haiku validator, photo analyzer)',
  agents: [
    {
      name: 'haiku-validator',
      agent: wrapStatelessAgent(haikuValidatorAgent),
      description: 'Validates 5-7-5 haiku syllable structure',
    },
    {
      name: 'photo-analyzer',
      agent: wrapStatelessAgent(photoAnalyzerAgent),
      description: 'Analyzes cat photos (mock mode)',
    },
  ],
};

/**
 * All MCP collections exported by this package
 */
export const collections: Record<string, MCPCollection> = {
  'cat-agents': catAgents,
};

/**
 * Default collection (when package is used without :collection suffix)
 */
export const defaultCollection = catAgents;
