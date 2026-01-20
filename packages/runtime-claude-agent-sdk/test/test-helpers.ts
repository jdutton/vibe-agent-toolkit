import type { ClaudeAgentMcpServer } from '../src/types.js';

/**
 * Tool handler response type from Claude Agent SDK
 */
type ToolHandlerResponse = {
  content?: Array<{ type: string; text?: string }>;
};

/**
 * Registered tool definition from Claude Agent SDK
 */
type RegisteredTool = {
  handler: (input: unknown) => Promise<ToolHandlerResponse>;
};

/**
 * Executes a Claude Agent SDK tool handler and parses the JSON response
 */
export async function executeToolHandler(
  toolHandler: (input: unknown) => Promise<ToolHandlerResponse>,
  input: unknown,
): Promise<unknown> {
  const response = await toolHandler(input);

  if (response.content?.[0]?.type === 'text' && response.content[0].text) {
    return JSON.parse(response.content[0].text);
  }
  throw new Error('Invalid tool response format');
}

/**
 * Gets registered tools from Claude Agent SDK MCP server instance
 */
export function getRegisteredTools(server: ClaudeAgentMcpServer): Record<string, RegisteredTool> {
  // Claude Agent SDK's internal structure uses private _registeredTools
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (server.instance as any)._registeredTools;
}

/**
 * Creates an async function that executes a single tool by name
 */
export function createToolExecutor(
  server: ClaudeAgentMcpServer,
  toolName: string,
): (input: unknown) => Promise<unknown> {
  const registeredTools = getRegisteredTools(server);
  const toolDef = registeredTools[toolName];

  if (!toolDef) {
    throw new Error(`No tool found with name: ${toolName}`);
  }

  return async (input: unknown) => executeToolHandler(toolDef.handler, input);
}

/**
 * Creates a record of async functions for batch-converted tools
 */
export function createBatchToolExecutors(
  server: ClaudeAgentMcpServer,
  toolKeys: string[],
): Record<string, (input: unknown) => Promise<unknown>> {
  const registeredTools = getRegisteredTools(server);
  const functions: Record<string, (input: unknown) => Promise<unknown>> = {};

  for (const key of toolKeys) {
    const toolDef = registeredTools[key];
    if (toolDef) {
      functions[key] = async (input: unknown) => executeToolHandler(toolDef.handler, input);
    }
  }

  return functions;
}
