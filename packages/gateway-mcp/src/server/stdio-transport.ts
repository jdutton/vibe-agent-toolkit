// eslint-disable-next-line sonarjs/deprecation -- Using Server for advanced request handling with stdio transport
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { createConnectionId } from '../types.js';

import { MCPGateway } from './mcp-gateway.js';

/**
 * Stdio transport implementation for Claude Desktop
 *
 * Process lifetime = connection lifetime
 * Single connection per process
 */
export class StdioMCPGateway extends MCPGateway {
  // eslint-disable-next-line sonarjs/deprecation -- Server needed for request handler API
  private server?: Server;
  private readonly connectionId = createConnectionId(`stdio-${process.pid}`);

  /**
   * Start the stdio MCP server
   */
  override async start(): Promise<void> {
    this.logger.info('Starting stdio MCP gateway', {
      connectionId: this.connectionId,
      toolCount: this.tools.size,
    });

    // Create MCP server
    // eslint-disable-next-line sonarjs/deprecation -- Server provides request handler registration API
    this.server = new Server(
      {
        name: 'vat-agents',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register tools/list handler
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = this.getToolDefinitions();
      this.logger.debug('tools/list requested', { toolCount: tools.length });
      return { tools };
    });

    // Register tools/call handler
    this.server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
      const { name, arguments: args } = request.params;

      this.logger.debug('Tool call received', {
        tool: name,
        connectionId: this.connectionId,
      });

      const tracer = this.observability.getTracer();

      return tracer.startActiveSpan('tool.call', async (span) => {
        span.setAttribute('tool', name);
        span.setAttribute('connection', this.connectionId);

        try {
          // Get tool registration
          const registration = this.getToolRegistration(name);

          // Execute via adapter
          const result = await registration.adapter.execute(
            registration.agent,
            (args as Record<string, unknown>) ?? {},
            this.connectionId
          );

          span.setAttribute('status', result.isError ? 'error' : 'success');
          span.end();

          this.logger.info('Tool call completed', {
            tool: name,
            isError: result.isError,
          });

          // Return result (MCPToolResult is compatible with CallToolResult)
          return result as CallToolResult;
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: 1 }); // Error status
          span.end();

          this.logger.error('Tool call failed', error as Error, {
            tool: name,
            connectionId: this.connectionId,
          });

          // Return error as MCP result
          return {
            content: [
              {
                type: 'text',
                text: `Internal error: ${(error as Error).message}`,
              },
            ],
            isError: true,
          } as CallToolResult;
        }
      });
    });

    // Connect stdio transport
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    this.logger.info('Stdio MCP gateway started', {
      connectionId: this.connectionId,
    });

    // Log to stderr (stdout is reserved for MCP protocol)
    console.error('[MCP Gateway] Ready - listening on stdio');
  }
}
