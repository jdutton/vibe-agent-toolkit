# MCP Commands

Expose VAT agents via Model Context Protocol (MCP) for Claude Desktop and other MCP clients.

## Overview

The MCP Gateway exposes VAT agents as tools that LLM systems can discover and invoke. This enables:

- **Claude Desktop integration** - Use agents through conversational UI
- **Agent orchestration** - LLMs coordinate multiple agents for complex tasks
- **Standardized discovery** - Clients can find and understand available tools

## Commands

### `vat mcp list-collections`

List known MCP agent packages.

**Usage:**
```bash
vat mcp list-collections [options]
```

**Options:**
- `--debug` - Enable debug logging

**Output:**
Lists all known packages that export MCP agent collections.

**Example:**
```bash
$ vat mcp list-collections

Available MCP agent packages:

  @vibe-agent-toolkit/vat-example-cat-agents
    Example cat breeding agents (haiku validator, photo analyzer)

Usage:
  vat mcp serve <package>                 # Start MCP server
  vat mcp serve <package> --print-config  # Show Claude Desktop config
```

### `vat mcp serve`

Start an MCP stdio server exposing agents from a package.

**Usage:**
```bash
vat mcp serve <package> [options]
```

**Arguments:**
- `<package>` - Package name or file path
  - Package: `@scope/package` (from node_modules)
  - File path: `./path` or `/abs/path` (local development)
  - Collection suffix: `package:collection-name` (if multiple)

**Options:**
- `--debug` - Enable debug logging
- `--print-config` - Print Claude Desktop configuration and exit

**Behavior:**
- Runs until terminated (Ctrl+C)
- Writes MCP protocol messages to stdout
- Writes logs to stderr (does not interfere with protocol)

**Example - Production:**
```bash
vat mcp serve @vibe-agent-toolkit/vat-example-cat-agents
```

**Example - Local Development:**
```bash
vat mcp serve ./packages/vat-example-cat-agents
```

**Example - Show Configuration:**
```bash
$ vat mcp serve @vibe-agent-toolkit/vat-example-cat-agents --print-config

Claude Desktop configuration for '@vibe-agent-toolkit/vat-example-cat-agents':

Add this to ~/.claude/config.json:

{
  "mcpServers": {
    "vat-example-cat-agents": {
      "command": "vat",
      "args": ["mcp", "serve", "@vibe-agent-toolkit/vat-example-cat-agents"]
    }
  }
}

Then restart Claude Desktop to load the MCP server.
```

## Claude Desktop Integration

### Configuration File

MCP servers are configured in:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

### Basic Setup

1. **Generate configuration:**
   ```bash
   vat mcp serve <package> --print-config
   ```

2. **Add to Claude Desktop config:**
   Copy the generated JSON to your `claude_desktop_config.json`

3. **Restart Claude Desktop:**
   Completely quit and reopen the application

4. **Verify connection:**
   Check Claude Desktop developer console (View → Developer → Toggle Developer Tools)

### Development Setup

For local development with unreleased code:

```json
{
  "mcpServers": {
    "my-agents-dev": {
      "command": "node",
      "args": [
        "/path/to/vibe-agent-toolkit/packages/cli/dist/bin/vat",
        "mcp",
        "serve",
        "@my-scope/my-agents"
      ],
      "env": {
        "VAT_ROOT_DIR": "/path/to/vibe-agent-toolkit"
      }
    }
  }
}
```

The `VAT_ROOT_DIR` environment variable tells the wrapper to use local development code.

## Package Structure

MCP agent packages must export collections via the `/mcp-collections` entrypoint.

### Example: `src/mcp-collections.ts`

```typescript
import type { Agent, OneShotAgentOutput } from '@vibe-agent-toolkit/agent-schema';
import { createSuccess } from '@vibe-agent-toolkit/agent-schema';

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

// Wrap stateless agents for MCP
function wrapStatelessAgent<TInput, TOutput>(
  agent: { name: string; manifest: unknown; execute: (input: TInput) => TOutput | Promise<TOutput> }
): Agent<TInput, OneShotAgentOutput<TOutput, string>> {
  return {
    name: agent.name,
    manifest: agent.manifest as any,
    execute: async (input: TInput) => {
      const data = await Promise.resolve(agent.execute(input));
      return {
        result: createSuccess(data),
      };
    },
  };
}

export const myAgents: MCPCollection = {
  name: 'my-agents',
  description: 'My agent collection',
  agents: [
    {
      name: 'my-agent',
      agent: wrapStatelessAgent(myAgent),
      description: 'Agent description',
    },
  ],
};

export const collections: Record<string, MCPCollection> = {
  'my-agents': myAgents,
};

export const defaultCollection = myAgents;
```

### Example: `package.json`

```json
{
  "name": "@my-scope/my-agents",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./mcp-collections": {
      "types": "./dist/mcp-collections.d.ts",
      "default": "./dist/mcp-collections.js"
    }
  }
}
```

## Troubleshooting

### Server Won't Start

**Check logs:**
- **macOS:** `~/Library/Logs/Claude/mcp-server-<name>.log`
- **Windows:** `%APPDATA%\Claude\logs\mcp-server-<name>.log`
- **Linux:** `~/.config/Claude/logs/mcp-server-<name>.log`

**Common issues:**
1. **Package not installed:** Run `npm install <package>` or `bun install <package>`
2. **Package not built:** Run `bun run build` in development workspace
3. **Wrong path:** Verify command path in config matches your setup
4. **Missing entrypoint:** Ensure package exports `/mcp-collections`

### Tools Not Appearing

**Verify server is running:**
1. Open Claude Desktop developer console
2. Look for MCP connection logs
3. Check for error messages

**Test server manually:**
```bash
# Send initialize request
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | vat mcp serve <package>
```

Should receive JSON-RPC response on stdout.

### Development Mode Not Working

**Ensure VAT_ROOT_DIR is set:**
```bash
# Test in terminal first
VAT_ROOT_DIR=/path/to/workspace vat --version
# Should show "-dev" suffix
```

**Check config includes env:**
```json
{
  "env": {
    "VAT_ROOT_DIR": "/absolute/path/to/workspace"
  }
}
```

## Architecture

### Stdio Transport

The MCP server uses stdio transport for Claude Desktop:
- **stdin** - Receives JSON-RPC requests
- **stdout** - Sends JSON-RPC responses (protocol messages ONLY)
- **stderr** - Logs, debug output, errors

### Process Lifetime

The server runs until stdin closes:
1. Claude Desktop spawns the process
2. Server waits for JSON-RPC messages on stdin
3. Server sends responses on stdout
4. When stdin closes, server terminates

### Protocol Compliance

All implementations must:
- Write ONLY JSON-RPC to stdout
- Write all logs to stderr
- Handle stdio cleanup properly
- Support graceful shutdown on SIGINT

## Current Implementation

**Supported:**
- ✅ Stateless agents (pure function tools, one-shot LLM analyzers)
- ✅ Package-scoped collections
- ✅ Claude Desktop integration
- ✅ Local development with VAT_ROOT_DIR

**Not Yet Supported:**
- ❌ Stateful agents (conversational assistants)
- ❌ Global discovery registry
- ❌ HTTP transport
- ❌ WebSocket transport
- ❌ Multi-session management

See [MCP Gateway README](../../gateway-mcp/README.md) for planned features.

## See Also

- [MCP Gateway README](../../gateway-mcp/README.md)
- [Example Cat Agents](../../vat-example-cat-agents/README.md)
- [VAT Architecture](../../../docs/architecture/README.md)
