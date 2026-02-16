import type { CompatibilityEvidence } from '../types.js';

import { classifyCommandBinary } from './command-classifier.js';

/**
 * Scan an MCP config object for server runtime requirements.
 * Expects the parsed JSON from a .mcp.json file.
 */
export function scanMcpConfig(config: Record<string, unknown>, filePath: string): CompatibilityEvidence[] {
  const evidence: CompatibilityEvidence[] = [];

  const servers = config['mcpServers'];
  if (!servers || typeof servers !== 'object') return evidence;

  for (const [serverName, serverConfig] of Object.entries(servers as Record<string, unknown>)) {
    if (!serverConfig || typeof serverConfig !== 'object') continue;
    const sc = serverConfig as Record<string, unknown>;
    const command = sc['command'];
    if (typeof command !== 'string') continue;

    const classification = classifyCommandBinary(command);
    if (classification) {
      evidence.push({
        source: 'mcp-server',
        file: filePath,
        signal: `mcp-server: ${classification.signal}`,
        detail: `MCP server "${serverName}" uses command: ${command}`,
        impact: classification.impact,
      });
    }
  }

  return evidence;
}
